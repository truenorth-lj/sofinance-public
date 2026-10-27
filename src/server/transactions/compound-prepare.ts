import "@/lib/engine-host";
import "server-only";
import { buildAndSimulateCompound } from "@sofinance/engine/compound-atomic";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { issueCompoundPermit } from "@/lib/compound-permit";

export type CompoundPrepareCommand = {
  wallet: string;
  positionMint: string;
  sourceSignatures: string[];
};

// Quote deliberately calls the builder directly: it must not require a signing key.
export async function prepareCompound(command: CompoundPrepareCommand) {
  const { wallet, positionMint, sourceSignatures } = command;
  const { summary, transaction } = await buildAndSimulateCompound(wallet, positionMint, sourceSignatures);
  const permit = issueCompoundPermit(getSigningSecret(), {
    wallet, summary, message: Buffer.from(transaction.message.serialize()).toString("base64"),
  });
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
}
