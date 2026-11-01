/**
 * Client half of the shared DEX route (DESIGN.md §1.2): one `TxAdapter` per operation that prepares a single step by
 * POSTing to `/api/dex/[dex]/[op]` and hands it to the existing `runTx` pipeline, so the wallet send, the on-chain
 * check after a wallet error (4001 / 5000) and confirmation apply to every step. A multi-step operation is one `runTx`
 * per step, in order, passing each result's `planToken` and landed signature to the next.
 *
 * When a DEX's descriptor declares an ephemeral position cosigner, step 1 of an open creates that keypair here, sends
 * only its public key, and signs after the wallet; the secret never leaves the browser and is wiped when the run ends.
 * Nothing in this file names a DEX.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { createEphemeralMint, type EphemeralMint } from "@/lib/ephemeral-mint";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { addMintSignature, missingRequiredSignatures } from "@/lib/open-signatures";
import { TxNotSentError, type PreparedTx, type TxAdapter, type TxFlow } from "@/lib/tx-pipeline";
import type { PositionKey } from "@/lib/unified-positions/model";
import type { OpenRequest, StepContext, StepResult } from "./adapter";
import type { DexDescriptor } from "./types";

/** Hard cap so a prepare cannot spin past a Jupiter 429 wait with no UI error. */
export const DEX_PREPARE_TIMEOUT_MS = 45_000;

export type DexStepOp = "open" | "recovery";

type Common = { descriptor: DexDescriptor; context: StepContext; relayStore: JupiterRelayStore; beforeWallet?: () => void };
export type DexStepInput<Op extends DexStepOp> = Op extends "open"
  ? Common & { request: Omit<OpenRequest, "owner" | "cosigner"> }
  : Common & { positionKey: PositionKey };

/** The prepared step plus what the next step needs (`result.planToken`, `result.done`). */
export type DexPreparedStep = PreparedTx & { result: StepResult };

const FLOW: Record<DexStepOp, TxFlow> = { open: "open", recovery: "withdraw" };
const SUCCESS: Record<DexStepOp, string> = { open: "Position step confirmed", recovery: "Position closed" };
const MISMATCH = "The prepared step does not match your request. Nothing was sent; please try again.";

function decode(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
}

export function dexTxAdapter<Op extends DexStepOp>(op: Op): TxAdapter<DexStepInput<Op>, DexPreparedStep> {
  return {
    flow: FLOW[op],
    successTitle: SUCCESS[op],
    scope: (input) => ("positionKey" in input ? input.positionKey : `${input.descriptor.id}:${input.request.poolId}:${input.context.step}`),
    async prepare(input, { wallet }) {
      const { descriptor, context } = input;
      const needsCosigner = op === "open" && context.step === 1 && descriptor.meta.positionCosigner !== "none";
      const cosigner: EphemeralMint | null = needsCosigner ? createEphemeralMint() : null;
      try {
        const step = { step: context.step, priorSignatures: [...context.priorSignatures], ...(context.planToken ? { planToken: context.planToken } : {}) };
        const body = "positionKey" in input
          ? { wallet, positionKey: input.positionKey, ...step }
          : { request: { ...input.request, owner: wallet, ...(cosigner ? { cosigner: cosigner.publicKey.toBase58() } : {}) }, ...step };
        const response = await postWithJupiterRelay(`/api/dex/${encodeURIComponent(descriptor.id)}/${op}`, body,
          { store: input.relayStore, signal: AbortSignal.timeout(DEX_PREPARE_TIMEOUT_MS) });
        const data = await response.json() as Partial<StepResult> & { error?: string; code?: string };
        if (!response.ok) throw Object.assign(new TxNotSentError(data.error || "Preparation failed. Nothing was sent."), { code: data.code });
        const result = data as StepResult;
        const prepared = result.prepared;
        if (result.step !== context.step || !prepared || prepared.kind !== "solana-tx") throw new TxNotSentError(MISMATCH);
        const transaction = decode(prepared.transaction);
        const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures).map((key) => key.toBase58());
        if (signers[0] !== wallet) throw new TxNotSentError("The prepared transaction does not match your wallet. Nothing was sent.");
        const extra = signers.slice(1);
        const cosignerKey = cosigner?.publicKey.toBase58();
        if (extra.length > 1 || (extra.length === 1 && (extra[0] !== cosignerKey || prepared.cosignRef !== cosignerKey))) throw new TxNotSentError(MISMATCH);
        input.beforeWallet?.();
        return {
          transaction, result, lastValidBlockHeight: prepared.lastValidBlockHeight, sendPermit: prepared.sendPermit, landedPermit: prepared.landedPermit,
          ...(prepared.positionMint ? { positionMint: prepared.positionMint } : {}),
          ...(cosigner && extra.length === 1
            ? {
              cosign: (walletSigned: VersionedTransaction) => {
                const signed = addMintSignature(walletSigned, cosigner);
                if (missingRequiredSignatures(signed).length) throw new TxNotSentError("A required signature is missing, so nothing was sent.");
                return signed;
              },
            }
            : {}),
          dispose: () => cosigner?.dispose(),
        };
      } catch (error) {
        cosigner?.dispose();
        throw error;
      }
    },
  };
}
