import "@/lib/engine-host";
import "server-only";
import { issueSelectedPermit } from "@/lib/selected-permit";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { dexRegistry } from "./registry-instance";
import { APP_ADD_PREPARE, type AddPrepareCommand, type AddPrepareSurface, type AddPreparation } from "./add-prepare";

/** Prepare only: issuing these permits does not sign or send a wallet transaction. */
export async function prepareAdd(id: string, command: AddPrepareCommand, readSigningSecret: () => string, ...surface: AddPrepareSurface): Promise<AddPreparation> {
  // Bind identity and terms before the registry's lazy module load or any chain/network await.
  const initiated = { ...command, selection: { ...command.selection } };
  const { wallet, selection } = initiated;
  const [profile, context] = surface;
  context?.signal.throwIfAborted();
  const { summary, transaction } = profile === APP_ADD_PREPARE
    ? await dexRegistry.buildAdd(id, initiated, { enforceResaleFloor: false, signal: context.signal, budget: context.budget })
    : await dexRegistry.buildAdd(id, initiated);
  context?.signal.throwIfAborted();
  const secret = readSigningSecret();
  // One set of facts feeds both the permit and MCP's submit/sign-token arguments.
  // Field order preserves the existing serialized sign-token payload.
  const facts = { wallet, selection,
    requested: summary.quote.requested, expectedLiquidity: summary.quote.liquidity,
    startingLiquidity: summary.startingLiquidity, floorBps: summary.quote.floorBps,
    expiresAt: summary.expiresAt, lastValidBlockHeight: summary.lastValidBlockHeight,
    rangeSide: summary.quote.rangeSide, startingBalances: summary.startingBalances,
  };
  const permit = issueSelectedPermit(secret, { message: Buffer.from(transaction.message.serialize()).toString("base64"), ...facts });
  context?.signal.throwIfAborted();
  const unsignedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  return { summary, permit, unsignedTransaction, submitArgs: { permit, ...facts },
    ...(profile === APP_ADD_PREPARE ? txPermitsFor(wallet, unsignedTransaction, summary.lastValidBlockHeight, secret) : {}) };
}
