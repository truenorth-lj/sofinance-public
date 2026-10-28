import "@/lib/engine-host";
import "server-only";
import { buildAndSimulateCompound } from "@sofinance/engine/compound-atomic";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { APP_COMPOUND_PREPARE, MCP_COMPOUND_PREPARE } from "./surface-policy";

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
  const { summary, transaction } = profile === APP_COMPOUND_PREPARE
    ? await withFeeEstimateRetry(() => buildAndSimulateCompound(wallet, positionMint, sourceSignatures))
    : await buildAndSimulateCompound(wallet, positionMint, sourceSignatures);
  const permit = issueCompoundPermit(readSigningSecret(), {
    wallet, summary, message: Buffer.from(transaction.message.serialize()).toString("base64"),
  });
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
}
