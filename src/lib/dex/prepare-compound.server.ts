import "@/lib/engine-host";
import "server-only";
import type { VersionedTransaction } from "@solana/web3.js";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { dexRegistry } from "./registry-instance";
import { APP_COMPOUND_PREPARE, type CompoundPrepareCommand, type CompoundPrepareProfile, type CompoundRecoveryCommand } from "./compound-prepare";

function authorize<Summary extends { lastValidBlockHeight: number }>(wallet: string,
  { summary, transaction }: { summary: Summary; transaction: VersionedTransaction }, secret: string, relay: boolean) {
  const permit = issueCompoundPermit(secret, { wallet, summary, message: Buffer.from(transaction.message.serialize()).toString("base64") });
  const unsignedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  return { summary, permit, unsignedTransaction,
    ...(relay ? txPermitsFor(wallet, unsignedTransaction, summary.lastValidBlockHeight, secret) : {}) };
}

export async function prepareCompound(id: string, input: CompoundPrepareCommand, readSigningSecret: () => string,
  profile: CompoundPrepareProfile = APP_COMPOUND_PREPARE) {
  const command = structuredClone(input);
  const built = profile === APP_COMPOUND_PREPARE
    ? await withFeeEstimateRetry(() => dexRegistry.buildCompound(id, command))
    : await dexRegistry.buildCompound(id, command);
  return authorize(command.wallet, built, readSigningSecret(), profile === APP_COMPOUND_PREPARE);
}

/** Quote uses the same full simulation without reading signing configuration or issuing authorization. */
export async function simulateCompound(id: string, command: CompoundPrepareCommand) {
  return dexRegistry.buildCompound(id, command);
}

export async function prepareCompoundRecovery(id: string, input: CompoundRecoveryCommand, readSigningSecret: () => string) {
  const command = structuredClone(input);
  const built = await dexRegistry.buildCompoundRecovery(id, command);
  if ("alreadyClosed" in built) return built;
  return authorize(command.wallet, built, readSigningSecret(), true);
}
