/**
 * Client half of the shared DEX route (DESIGN.md §1.2): one `TxAdapter` per operation that prepares a single step by
 * POSTing to `/api/dex/[dex]/[op]` and hands it to the existing `runTx` pipeline, so the wallet send, the on-chain
 * check after a wallet error (4001 / 5000) and confirmation apply to every step. A multi-step operation is one `runTx`
 * per step through `useTxPipeline().runSteps`, which prepares the next step (with this result's `planToken` and the
 * signatures so far) only after the previous step is confirmed on Solana.
 *
 * A wallet that can signAndSendTransaction sends every step itself (LJ 2026-10-31: Phantom flags a transaction it
 * signed that someone else broadcasts); only a sign-only wallet falls back to our `/api/tx-send` relay, under the
 * 0.01 SOL wallet priority-fee ceiling (PM, 2026-11-02).
 * When a DEX's descriptor declares an ephemeral position cosigner, step 1 of an open creates that keypair here, sends
 * only its public key, and signs BEFORE the wallet (`presign`), which then signs and sends; on the sign-only relay path it
 * signs after the wallet instead (`cosign`). The secret never leaves the browser and is wiped when the run ends. A presigned transaction is one the wallet leaves unchanged (Phantom adds no
 * priority fee to it), so the step's fee is the base fee our SOL check counts.
 * Every step opts into the pipeline's pre-wallet guard (`TX_PREFLIGHT_POLICY`: server simulation with one re-prepare,
 * quote age, prompt expiry, counts), so each registered DEX gets it without a DEX-specific branch.
 * Nothing in this file names a DEX.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { createEphemeralMint, type EphemeralMint } from "@/lib/ephemeral-mint";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { addMintSignature, missingRequiredSignatures } from "@/lib/open-signatures";
import { isZeroSignature } from "@sofinance/engine/transaction-limits";
import { TX_PREFLIGHT_POLICY, TxNotSentError, type PreparedTx, type TxAdapter, type TxFlow } from "@/lib/tx-pipeline";
import type { PositionKey, WithdrawOutput } from "@/lib/unified-positions/model";
import type { OpenRequest, StepContext, StepResult } from "./adapter";
import type { DexDescriptor } from "./types";

/** Hard cap so a prepare cannot spin past a Jupiter 429 wait with no UI error. */
export const DEX_PREPARE_TIMEOUT_MS = 45_000;

/** `add` / `withdraw` / `claim` / `compound` act on an existing position (PR7–PR8 panels); `recovery` closes a half-made open. */
export type DexStepOp = "open" | "recovery" | "add" | "withdraw" | "claim" | "compound";

/** `beforeWallet` runs once the step is prepared and checked, just before the wallet is asked (it may throw to stop). */
type Common = { descriptor: DexDescriptor; context: StepContext; relayStore: JupiterRelayStore; beforeWallet?: (result: StepResult) => void };
type OnPosition = Common & { positionKey: PositionKey };
export type DexStepInput<Op extends DexStepOp> = Op extends "open"
  ? Common & { request: Omit<OpenRequest, "owner" | "cosigner"> }
  : Op extends "add" ? OnPosition & { input: { token: string; amountRaw: string } }
  : Op extends "withdraw" ? OnPosition & { fraction: number; output: WithdrawOutput }
  : OnPosition;

/** The prepared step plus what the next step needs (`result.planToken`, `result.done`). */
export type DexPreparedStep = PreparedTx & { result: StepResult };

const FLOW: Record<DexStepOp, TxFlow> = { open: "open", recovery: "withdraw", add: "add", withdraw: "withdraw", claim: "claim", compound: "compound" };
const SUCCESS: Record<DexStepOp, string> = {
  open: "Position step confirmed", recovery: "Position closed", add: "Liquidity added", withdraw: "Withdrawal confirmed", claim: "Fees claimed", compound: "Fees compounded",
};

/** The route body's op-specific fields: recovery names the `wallet`, the position ops the `owner` (checked on chain). */
function positionBody(op: DexStepOp, input: OnPosition & Partial<{ input: { token: string; amountRaw: string }; fraction: number; output: WithdrawOutput }>, wallet: string) {
  if (op === "recovery") return { wallet, positionKey: input.positionKey };
  return {
    owner: wallet, positionKey: input.positionKey,
    ...(op === "add" ? { input: input.input } : {}),
    ...(op === "withdraw" ? { fraction: input.fraction, output: input.output } : {}),
  };
}
const MISMATCH = "The prepared step does not match your request. Nothing was sent; please try again.";

function decode(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
}

export function dexTxAdapter<Op extends DexStepOp>(op: Op): TxAdapter<DexStepInput<Op>, DexPreparedStep> {
  return {
    flow: FLOW[op],
    successTitle: SUCCESS[op],
    preflight: TX_PREFLIGHT_POLICY,
    scope: (input) => ("positionKey" in input ? input.positionKey : `${input.descriptor.id}:${input.request.poolId}:${input.context.step}`),
    async prepare(input, { wallet }) {
      const { descriptor, context } = input;
      const needsCosigner = op === "open" && context.step === 1 && descriptor.meta.positionCosigner !== "none";
      const cosigner: EphemeralMint | null = needsCosigner ? createEphemeralMint() : null;
      try {
        const step = { step: context.step, priorSignatures: [...context.priorSignatures], ...(context.planToken ? { planToken: context.planToken } : {}) };
        const body = "positionKey" in input
          ? { ...positionBody(op, input, wallet), ...step }
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
        input.beforeWallet?.(result);
        return {
          transaction, result, lastValidBlockHeight: prepared.lastValidBlockHeight, sendPermit: prepared.sendPermit, landedPermit: prepared.landedPermit,
          ...(prepared.positionMint ? { positionMint: prepared.positionMint } : {}),
          ...(cosigner && extra.length === 1
            ? {
              presign: (unsigned: VersionedTransaction) => {
                unsigned.sign([cosigner]);
                const index = signers.indexOf(cosignerKey!);
                if (index < 1 || isZeroSignature(unsigned.signatures[index])) throw new TxNotSentError("A required signature is missing, so nothing was sent.");
                return unsigned;
              },
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
