import "@/lib/engine-host";
import "server-only";
import { issueOpenPositionPermit } from "@/lib/open-permit";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { assertNativeSolAllowedForPoolId } from "@/lib/sol-pool-native-input";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { dexRegistry } from "./registry-instance";
import { APP_OPEN_PREPARE, SINGLE_TX_SOL_OPEN_MESSAGE, type OpenPrepareCommand, type OpenPrepareProfile,
  type OpenQuoteCommand, type OpenQuoteProfile } from "./open-prepare";

export async function prepareOpen(id: string, input: OpenPrepareCommand, readSigningSecret: () => string, profile: OpenPrepareProfile) {
  const command = structuredClone(input);
  assertSolInputAllowed(command.selection);
  if (command.selection.inputKind === "native") throw new Error(SINGLE_TX_SOL_OPEN_MESSAGE);
  const { summary, transaction } = profile === APP_OPEN_PREPARE
    ? await withFeeEstimateRetry(() => dexRegistry.buildOpen(id, command, { enforceResaleFloor: false }))
    : await dexRegistry.buildOpen(id, command);
  const secret = readSigningSecret();
  const permit = issueOpenPositionPermit(secret, {
    wallet: command.wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
  });
  // Both required signatures stay empty: wallet first, then the client-held NFT mint.
  const unsignedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  return { summary, permit, unsignedTransaction,
    ...(profile === APP_OPEN_PREPARE ? txPermitsFor(command.wallet, unsignedTransaction, summary.lastValidBlockHeight, secret) : {}) };
}

export async function quoteOpen(id: string, command: OpenQuoteCommand, profile: OpenQuoteProfile) {
  assertSolInputAllowed(command.selection);
  assertNativeSolAllowedForPoolId(command.selection);
  return dexRegistry.quoteOpen(id, command, profile);
}
