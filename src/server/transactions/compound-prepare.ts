import "@/lib/engine-host";
import "server-only";
import { getProtocolAdapter } from "@sofinance/engine/protocols/registry";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { APP_COMPOUND_PREPARE, MCP_COMPOUND_PREPARE } from "./surface-policy";
import { sendPermitFor } from "@/lib/tx-send/permit";

export type CompoundPrepareCommand = {
  wallet: string;
  positionMint: string;
  sourceSignatures: string[];
};

// Quote deliberately calls the builder directly: it must not require a signing key.
export async function prepareCompound(
  command: CompoundPrepareCommand,
  readSigningSecret: () => string,
  profile: typeof APP_COMPOUND_PREPARE | typeof MCP_COMPOUND_PREPARE = APP_COMPOUND_PREPARE,
) {
  const { wallet, positionMint, sourceSignatures } = command;
  const { buildAndSimulateCompound } = getProtocolAdapter();
  const { summary, transaction } = profile === APP_COMPOUND_PREPARE
    ? await withFeeEstimateRetry(() => buildAndSimulateCompound(wallet, positionMint, sourceSignatures))
    : await buildAndSimulateCompound(wallet, positionMint, sourceSignatures);
  const secret = readSigningSecret();
  const permit = issueCompoundPermit(secret, {
    wallet, summary, message: Buffer.from(transaction.message.serialize()).toString("base64"),
  });
  // Relay permit for /api/tx-send (app surface only; MCP signs on the sign page, which gets it from verify-sign-token).
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    ...(profile === APP_COMPOUND_PREPARE ? { sendPermit: sendPermitFor(wallet, Buffer.from(transaction.serialize()).toString("base64"), secret) } : {}) };
}
