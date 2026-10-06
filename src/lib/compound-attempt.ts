import bs58 from "bs58";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { CompoundAccount, CompoundSummary } from "./compound-types";
import type { CompoundRecoverySummary } from "./compound-recovery-types";

type AttemptIdentity = { version: 1; wallet: string; positionMint: string; signature: string; createdAt: number };
export type CompoundAttempt = AttemptIdentity & (
  { kind: "compound"; summary: CompoundSummary } | { kind: "recovery"; summary: CompoundRecoverySummary; sourceSignature?: string }
);
export type CompoundReceipt = { wallet: string; positionMint: string; sourceSignature: string;
  compoundAccounts: [CompoundAccount, CompoundAccount] };
export type CompoundPrepared = { summary: CompoundSummary; permit: string; unsignedTransaction: string };
export type RecoveryPrepared = { summary: CompoundRecoverySummary; permit: string; unsignedTransaction: string };
type StorageRead = Pick<Storage, "getItem">;
type StorageWrite = StorageRead & Pick<Storage, "setItem">;

export const compoundAttemptKey = (wallet: string) => `sofinance:compound:v1:${wallet}`;
export const compoundReceiptsKey = (wallet: string) => `sofinance:compound-receipts:v1:${wallet}`;
export const receiptId = (receipt: { compoundAccounts: readonly CompoundAccount[] }) => receipt.compoundAccounts.map((item) => item.address).join(":");

function publicKey(value: unknown): value is string {
  try { return typeof value === "string" && new PublicKey(value).toBase58() === value; } catch { return false; }
}
function signature(value: unknown): value is string {
  try { return typeof value === "string" && bs58.decode(value).length === 64; } catch { return false; }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const raw = (value: unknown): value is string => typeof value === "string" && /^\d{1,40}$/.test(value);
const signedRaw = (value: unknown): value is string => typeof value === "string" && /^-?\d{1,40}$/.test(value);
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const decimals = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 255;
function accounts(value: unknown): value is CompoundAccount[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 2 && value.every((item) => object(item) &&
    typeof item.seed === "string" && /^(?:[0-9a-f]{32}|[A-Za-z0-9_-]{22})$/.test(item.seed) &&
    publicKey(item.address) && publicKey(item.mint) && publicKey(item.program) &&
    [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(item.program) &&
    positiveInteger(item.space) && positiveInteger(item.rentLamports));
}
function completeSummary(summary: Record<string, unknown>) {
  const state = summary.state;
  if (!object(state) || !["mintA", "mintB", "nftAta", "programId", "vaultA", "vaultB"].every((key) => publicKey(state[key])) ||
    !decimals(state.decimalsA) || !decimals(state.decimalsB) || !Array.isArray(state.rewards) ||
    !state.rewards.every((reward) => object(reward) && publicKey(reward.mint) && publicKey(reward.vault) &&
      publicKey(reward.account) && decimals(reward.decimals) && raw(reward.estimatedAmount) && typeof reward.compounded === "boolean")) return false;
  if (summary.swaps !== undefined && (!Array.isArray(summary.swaps) || summary.swaps.length > 4 ||
    !summary.swaps.every((swap) => object(swap) && publicKey(swap.inputMint) && publicKey(swap.outputMint) &&
      publicKey(swap.poolId) && raw(swap.inputAmount) && raw(swap.minOutputAmount) && raw(swap.quotedOutputAmount) &&
      raw(swap.sqrtPriceAfterX64) && decimals(swap.inputDecimals) && decimals(swap.outputDecimals) &&
      (swap.simulatedOutputAmount === undefined || raw(swap.simulatedOutputAmount))))) return false;
  if (summary.priorSources !== undefined && (!Array.isArray(summary.priorSources) || summary.priorSources.length > 6 ||
    !summary.priorSources.every((source) => object(source) && signature(source.sourceSignature) &&
      ["address", "mint", "program", "destination"].every((key) => publicKey(source[key])) && raw(source.amount) &&
      positiveInteger(source.refundLamports)))) return false;
  return ["liquidity", "startingLiquidity", "amountMaxA", "amountMaxB", "simulatedEndingLiquidity", "simulatedDustA", "simulatedDustB", "maxSolDebitLamports"].every((key) => raw(summary[key])) &&
    signedRaw(summary.simulatedSolDebitLamports) &&
    object(summary.simulatedHarvest) && raw(summary.simulatedHarvest.a) && raw(summary.simulatedHarvest.b) &&
    Number.isSafeInteger(summary.feeLamports) && Number.isSafeInteger(summary.rentLamports) &&
    Array.isArray(summary.simulatedRewards) && summary.simulatedRewards.every((reward) => object(reward) && publicKey(reward.mint) && raw(reward.amount));
}
function completeRecoveryAccount(value: unknown) {
  return object(value) && raw(value.amount) && decimals(value.decimals) && publicKey(value.destination) && positiveInteger(value.sourceLamports);
}
export function parseCompoundAttempt(value: unknown, wallet: string): CompoundAttempt | null {
  if (!object(value) || value.version !== 1 || value.wallet !== wallet || !publicKey(value.wallet) ||
    !publicKey(value.positionMint) || !signature(value.signature) || !Number.isSafeInteger(value.createdAt) ||
    !object(value.summary) || !accounts(value.summary.compoundAccounts) ||
    !publicKey(value.summary.blockhash) || !positiveInteger(value.summary.lastValidBlockHeight) ||
    !positiveInteger(value.summary.expiresAt)) return null;
  if (value.kind === "compound") {
    const summary = value.summary;
    if (summary.operation !== "compound" || summary.simulated !== true || !accounts(summary.compoundAccounts) || summary.compoundAccounts.length !== 2 || summary.positionMint !== value.positionMint ||
      !object(summary.state) || summary.state.wallet !== wallet || typeof summary.liquidity !== "string" ||
      !/^\d+$/.test(summary.liquidity) || !publicKey(summary.positionAccount) || !publicKey(summary.poolId) || !completeSummary(summary)) return null;
  } else if (value.kind === "recovery") {
    if (value.summary.simulated !== true || value.summary.wallet !== wallet || value.summary.operation !== "recovery" ||
      !value.summary.compoundAccounts.every(completeRecoveryAccount) ||
      (value.sourceSignature !== undefined && !signature(value.sourceSignature))) return null;
  } else return null;
  return value as unknown as CompoundAttempt;
}
export function loadCompoundAttempt(storage: StorageRead, wallet: string) {
  const raw = storage.getItem(compoundAttemptKey(wallet));
  if (raw === null) return { attempt: null, invalid: false };
  try {
    const attempt = parseCompoundAttempt(JSON.parse(raw), wallet);
    return { attempt, invalid: attempt === null };
  } catch { return { attempt: null, invalid: true }; }
}
export function loadCompoundReceipts(storage: StorageRead, wallet: string) {
  const raw = storage.getItem(compoundReceiptsKey(wallet));
  if (raw === null) return { receipts: [] as CompoundReceipt[], invalid: false };
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || !values.every((value) => object(value) && value.wallet === wallet &&
      publicKey(value.positionMint) && signature(value.sourceSignature) && accounts(value.compoundAccounts) && value.compoundAccounts.length === 2)) {
      return { receipts: [] as CompoundReceipt[], invalid: true };
    }
    return { receipts: values as CompoundReceipt[], invalid: false };
  } catch { return { receipts: [] as CompoundReceipt[], invalid: true }; }
}

export function persistCompoundReceipt(storage: StorageWrite, receipt: CompoundReceipt) {
  if (!publicKey(receipt.wallet) || !publicKey(receipt.positionMint) || !signature(receipt.sourceSignature) ||
    !accounts(receipt.compoundAccounts) || receipt.compoundAccounts.length !== 2) {
    throw new Error("Yield account record cannot be verified");
  }
  const previous = loadCompoundReceipts(storage, receipt.wallet);
  if (previous.invalid) throw new Error("Compound balance record cannot be read; please verify records, transaction not broadcast");
  const serialized = JSON.stringify([...previous.receipts.filter((item) => receiptId(item) !== receiptId(receipt)), receipt]);
  storage.setItem(compoundReceiptsKey(receipt.wallet), serialized);
  if (storage.getItem(compoundReceiptsKey(receipt.wallet)) !== serialized) {
    throw new Error("Unable to save yield account record; transaction not broadcast");
  }
}

// Persist recovery addresses first. A storage failure must prevent broadcast; prior unresolved receipts survive.
export function persistCompoundAttempt(storage: StorageWrite, attempt: CompoundAttempt) {
  if (attempt.kind === "compound") {
    const receipt: CompoundReceipt = { wallet: attempt.wallet, positionMint: attempt.positionMint,
      sourceSignature: attempt.signature, compoundAccounts: attempt.summary.compoundAccounts };
    persistCompoundReceipt(storage, receipt);
  }
  storage.setItem(compoundAttemptKey(attempt.wallet), JSON.stringify(attempt));
  if (storage.getItem(compoundAttemptKey(attempt.wallet)) !== JSON.stringify(attempt)) {
    throw new Error("Unable to save transaction signature; transaction not broadcast");
  }
}
export function removeRecoveredReceipt(storage: StorageWrite, attempt: CompoundAttempt) {
  const saved = loadCompoundReceipts(storage, attempt.wallet);
  if (saved.invalid) throw new Error("Balance recovered, but local records need verification");
  const recoveredAddresses = attempt.summary.compoundAccounts.map((item) => item.address);
  storage.setItem(compoundReceiptsKey(attempt.wallet), JSON.stringify(saved.receipts.filter((item) =>
    attempt.kind === "recovery" && attempt.sourceSignature ? item.sourceSignature !== attempt.sourceSignature :
      !item.compoundAccounts.every((account) => recoveredAddresses.includes(account.address)))));
}

// Call only after chain confirmation: a prepared or ambiguous transaction has not consumed the old accounts.
export function removeConsumedCompoundReceipts(storage: StorageWrite, attempt: CompoundAttempt) {
  if (attempt.kind !== "compound") return;
  const sources = attempt.summary.priorSources || [];
  if (sources.length === 0) return;
  const saved = loadCompoundReceipts(storage, attempt.wallet);
  if (saved.invalid) throw new Error("Compound confirmed, but prior yield account records need verification");
  const serialized = JSON.stringify(saved.receipts.filter((receipt) =>
    receipt.sourceSignature === attempt.signature || !receipt.compoundAccounts.every((account) =>
      sources.some((source) => source.sourceSignature === receipt.sourceSignature && source.address === account.address))));
  storage.setItem(compoundReceiptsKey(attempt.wallet), serialized);
  if (storage.getItem(compoundReceiptsKey(attempt.wallet)) !== serialized) {
    throw new Error("Compound confirmed, but unable to update prior yield account records");
  }
}

// Snapshot before the provider call: wallets may mutate the input object while signing.
export function signedCompoundTransaction(signed: VersionedTransaction, originalMessage: Uint8Array, wallet: string) {
  const message = signed.message.serialize();
  if (message.length !== originalMessage.length || message.some((byte, index) => byte !== originalMessage[index])) {
    throw new Error("Wallet modified transaction content; broadcast stopped");
  }
  if (signed.message.staticAccountKeys[0]?.toBase58() !== wallet) throw new Error("Signing wallet does not match transaction payer");
  const bytes = signed.signatures[0];
  if (!bytes || bytes.every((byte) => byte === 0)) throw new Error("Wallet did not return transaction signature");
  return { signature: bs58.encode(bytes), signedTransaction: btoa(String.fromCharCode(...signed.serialize())) };
}
