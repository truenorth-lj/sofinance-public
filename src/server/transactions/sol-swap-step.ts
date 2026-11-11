import "@/lib/engine-host";
import "server-only";
import bs58 from "bs58";
import { buildAndSimulateSolSwapStep, isSolSwapCreditSpent, readSolSwapDelivery } from "@sofinance/engine/sol-swap-step";
import { parseTokenAmount } from "@sofinance/engine/amount";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { issueSolSwapPermit } from "@/lib/sol-swap-permit";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { rpcConnection } from "@sofinance/engine/rpc";
import type { Connection } from "@solana/web3.js";
import {
  getSolSwapCreditStore, SolSwapCreditStoreUnavailableError, type SolSwapCreditClaim, type SolSwapCreditStore,
} from "@/lib/sol-swap-credit-store";

/** How long after step 1 lands a step-2 open may still skip the (already paid) fee. */
export const SOL_SWAP_FEE_CREDIT_MS = 30 * 60_000;

export async function prepareSolSwapStep(wallet: string, poolId: string, amount: string) {
  assertSolInputAllowed({ inputKind: "native" });
  const { summary, transaction } = await withFeeEstimateRetry(() => buildAndSimulateSolSwapStep(wallet, poolId, amount));
  const secret = getSigningSecret();
  const permit = issueSolSwapPermit(secret, {
    wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
  });
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"), ...txPermitsFor(wallet, Buffer.from(transaction.serialize()).toString("base64"), summary.lastValidBlockHeight, secret) };
}

export async function readSolSwapStepStatus(wallet: string, signature: string, outputMint: string, lastValidBlockHeight?: number) {
  return readSolSwapDelivery({ signature, wallet, outputMint, lastValidBlockHeight });
}

/** Shown when the given transaction is not a SoFinance step 1/2 SOL swap (other program, other input, extra transfers). */
export const SOL_SWAP_NOT_STEP_ONE_MESSAGE =
  "That transaction isn't a SoFinance step 1/2 SOL swap, so this open can't skip its fee. Open with the tokens as a normal deposit.";
/** Shown when the step-1 swap paid less than the protocol fee due on the SOL it swapped. */
export const SOL_SWAP_FEE_SHORT_MESSAGE =
  "Step 1/2 swap did not pay the full protocol fee, so this open can't skip its fee. Open with the tokens as a normal deposit.";
/** Shown when a step-1 swap's tokens were already deposited (or moved) after the swap. */
export const SOL_SWAP_CREDIT_USED_MESSAGE =
  "This SOL swap was already used for an open. To deposit more, open with the tokens as a normal deposit (the usual fee applies).";

/** Shown when an earlier step 2/2 open prepared from this swap could still land on-chain. */
export const SOL_SWAP_CREDIT_PENDING_MESSAGE =
  "Your last step 2/2 open for this SOL swap can still go through. Wait about a minute for it to expire, then try again.";
/** Shown when the fee-credit ledger can't be read or written: the open is not prepared fee-free unrecorded. */
export const SOL_SWAP_CREDIT_UNAVAILABLE_MESSAGE =
  "We couldn't check this SOL swap right now, so the open wasn't prepared. Please try again in a moment.";

/** Why a step-2 fee credit was refused (logged with the swap's top-level program ids; never full addresses). */
export type SolSwapCreditRefusal =
  | "invalid_signature" | "not_confirmed" | "not_sol_swap" | "fee_short" | "too_old" | "over_delivered"
  | "spent" | "pending_open" | "other_wallet" | "store_unavailable";

const short = (value: string) => value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;

function refuse(reason: SolSwapCreditRefusal, message: string, context: { wallet: string; signature: string; feeCheck?: string; programIds?: string[] }) {
  // eslint-disable-next-line no-console -- deliberate audit line for every refused step-2 fee credit (PM)
  console.warn("[sol-swap-credit-refused]", JSON.stringify({
    reason, feeCheck: context.feeCheck ?? null, wallet: short(context.wallet), swap: short(context.signature),
    programs: (context.programIds ?? []).map(short),
  }));
  return new Error(message);
}

/**
 * Step 2/2 fee credit, read from the chain: the open skips its fee only when the step-1 swap is confirmed, paid by
 * this wallet, is a server-built step-1 SOL swap that paid the protocol fee due on the SOL it wrapped (engine
 * `checkSolSwapStepFee`, from the transaction itself), is recent, delivered at least the amount this open deposits,
 * and its tokens have not been moved since. Returns the swap's slot (step 2 never simulates against state from
 * before the swap landed) and its output accounts. The credit is single-use only once `claimSolSwapFeeCredit`
 * recorded it for the prepared open.
 */
export async function assertSolSwapFeeCredit(wallet: string, signature: string, inputMint: string, amount: string) {
  const context = { wallet, signature: String(signature) };
  let decoded = 0;
  try { decoded = bs58.decode(signature).length; } catch { /* not base58 */ }
  if (typeof signature !== "string" || decoded !== 64) throw refuse("invalid_signature", "Invalid step-1 swap signature", context);
  const delivery = await readSolSwapDelivery({ signature, wallet, outputMint: inputMint });
  if (delivery.status !== "confirmed") throw refuse("not_confirmed", "Step 1/2 swap is not confirmed yet", context);
  const seen = { ...context, feeCheck: delivery.feeCheck, programIds: delivery.programIds };
  if (!delivery.feeAccountPaid) {
    throw delivery.feeCheck === "not_sol_swap"
      ? refuse("not_sol_swap", SOL_SWAP_NOT_STEP_ONE_MESSAGE, seen)
      : refuse("fee_short", SOL_SWAP_FEE_SHORT_MESSAGE, seen);
  }
  if (delivery.blockTime !== null && Date.now() - delivery.blockTime * 1000 > SOL_SWAP_FEE_CREDIT_MS) {
    throw refuse("too_old", "Step 1/2 swap is too old to continue; open with the tokens as a normal deposit", seen);
  }
  if (parseTokenAmount(amount, delivery.decimals) > BigInt(delivery.delivered)) {
    throw refuse("over_delivered", "Open amount exceeds what the step 1/2 swap delivered", seen);
  }
  // Last: the only check that reads more than the swap itself.
  if (await isSolSwapCreditSpent({ signature, wallet, outputMint: inputMint, outputAccounts: delivery.outputAccounts })) {
    throw refuse("spent", SOL_SWAP_CREDIT_USED_MESSAGE, seen);
  }
  return { slot: delivery.slot, outputAccounts: delivery.outputAccounts, programIds: delivery.programIds };
}

/**
 * Makes a step-1 swap's fee credit single-use, after step 2 was built (so the prepared transaction's blockhash is
 * known) and before it is returned. The first prepare records the swap, bound to its open's blockhash. Another
 * prepare for the same swap is refused while that open could still land (its blockhash has not expired), so two
 * fee-free opens can not be prepared inside one blockhash window. Once it has expired, the claim moves to the new
 * open only if the swap's tokens are still unmoved (the expired open never landed) and no concurrent prepare moved
 * it first (compare-and-set on the old blockhash). A database failure refuses the waiver.
 */
export async function claimSolSwapFeeCredit(input: {
  wallet: string; signature: string; inputMint: string; outputAccounts: string[]; programIds?: string[];
  blockhash: string; lastValidBlockHeight: number;
}, deps: { store?: () => SolSwapCreditStore; connection?: () => Connection } = {}) {
  const context = { wallet: input.wallet, signature: input.signature, programIds: input.programIds };
  const claim: SolSwapCreditClaim = {
    swapSignature: input.signature, wallet: input.wallet,
    openBlockhash: input.blockhash, openLastValidBlockHeight: input.lastValidBlockHeight,
  };
  const ledger = async <T>(work: (store: SolSwapCreditStore) => Promise<T>) => {
    try { return await work((deps.store ?? getSolSwapCreditStore)()); }
    catch (error) {
      if (error instanceof SolSwapCreditStoreUnavailableError) throw refuse("store_unavailable", SOL_SWAP_CREDIT_UNAVAILABLE_MESSAGE, context);
      throw error;
    }
  };
  const first = await ledger((store) => store.claim(claim));
  if (first.claimed) return;
  const previous = first.existing;
  if (previous.wallet !== input.wallet) throw refuse("other_wallet", SOL_SWAP_CREDIT_USED_MESSAGE, context);
  const connection = (deps.connection ?? rpcConnection)();
  if (await connection.getBlockHeight("confirmed") <= previous.openLastValidBlockHeight) {
    throw refuse("pending_open", SOL_SWAP_CREDIT_PENDING_MESSAGE, context);
  }
  // The earlier open can no longer land; re-read the chain now, since it may have landed before it expired.
  if (await isSolSwapCreditSpent({ signature: input.signature, wallet: input.wallet, outputMint: input.inputMint,
    outputAccounts: input.outputAccounts, connection })) {
    throw refuse("spent", SOL_SWAP_CREDIT_USED_MESSAGE, context);
  }
  if (!await ledger((store) => store.reclaim({ ...claim, previousBlockhash: previous.openBlockhash }))) {
    throw refuse("pending_open", SOL_SWAP_CREDIT_PENDING_MESSAGE, context);
  }
}
