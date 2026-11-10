/**
 * Deposit-time stock price from trades in a reference stock/USDC pool (`stock-reference-pools.ts`), pure.
 * A trade is read from the pool's own two vaults: price = |ΔUSDC| / |Δstock| in raw amount / decimals, the same unit the
 * report uses for share amounts (a ScaledUiAmount multiplier is not applied, as everywhere else in the report).
 */
import { USDC_MINT } from "./rwa-allowlist";
import { USDC_DECIMALS, type StockReferencePool } from "./stock-reference-pools";

/** Trades older than this before the deposit are not deposit-time prices. */
export const ENTRY_PRICE_MAX_AGE_SECONDS = 3_600;
/** Median of the nearest usable trades; the lookup stops reading the pool once it has this many. */
export const ENTRY_PRICE_TRADES = 3;
/** Smaller fills are dust and rounding-sensitive. */
export const MIN_TRADE_USDC = 1;

export type RawTokenBalance = { accountIndex: number; mint: string; uiTokenAmount: { amount: string; decimals: number } };
/** The parts of a `getTransaction` (jsonParsed or json, v0 or v1) result this module reads. */
export type RawPoolTransaction = {
  blockTime?: number | null;
  transaction: { message: { accountKeys: ReadonlyArray<string | { pubkey: string }> } };
  meta: {
    err: unknown;
    preTokenBalances?: readonly RawTokenBalance[] | null;
    postTokenBalances?: readonly RawTokenBalance[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
};
export type PoolTrade = { signature: string; blockTime: number; priceUsd: number; usdcSize: number };
export type EntryPriceResult =
  | { status: "ok"; priceUsd: number; trades: PoolTrade[] }
  | { status: "no_trade"; priceUsd: null; trades: [] };

function accountKeys(tx: RawPoolTransaction): string[] {
  const keys = tx.transaction.message.accountKeys.map((key) => typeof key === "string" ? key : key.pubkey);
  // jsonParsed already lists lookup-table accounts; plain json lists them only in meta.loadedAddresses.
  if (tx.transaction.message.accountKeys.some((key) => typeof key !== "string")) return keys;
  return [...keys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
}

function vaultDelta(tx: RawPoolTransaction, keys: readonly string[], vault: string, mint: string): { raw: bigint; decimals: number } | null {
  const find = (balances: readonly RawTokenBalance[] | null | undefined) =>
    balances?.find((balance) => keys[balance.accountIndex] === vault && balance.mint === mint);
  const pre = find(tx.meta?.preTokenBalances), post = find(tx.meta?.postTokenBalances);
  const decimals = post?.uiTokenAmount.decimals ?? pre?.uiTokenAmount.decimals;
  if (decimals === undefined) return null;
  const amount = (balance: RawTokenBalance | undefined) => /^\d+$/.test(balance?.uiTokenAmount.amount ?? "0") ? BigInt(balance?.uiTokenAmount.amount ?? "0") : null;
  const before = amount(pre), after = amount(post);
  return before === null || after === null ? null : { raw: after - before, decimals };
}

const abs = (value: bigint) => value < 0n ? -value : value;
const ui = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** One swap through the reference pool, or null: failed, not a swap (both vaults move the same way), or under $1. */
export function tradeFromTransaction(signature: string, tx: RawPoolTransaction | null, ref: StockReferencePool): PoolTrade | null {
  if (!tx?.meta || tx.meta.err || typeof tx.blockTime !== "number") return null;
  const keys = accountKeys(tx);
  const stock = vaultDelta(tx, keys, ref.stockVault, ref.mint);
  const usdc = vaultDelta(tx, keys, ref.usdcVault, USDC_MINT);
  if (!stock || !usdc || stock.raw === 0n || usdc.raw === 0n || (stock.raw > 0n) === (usdc.raw > 0n)) return null;
  if (usdc.decimals !== USDC_DECIMALS) return null;
  const usdcSize = ui(abs(usdc.raw), usdc.decimals), shares = ui(abs(stock.raw), stock.decimals);
  if (usdcSize < MIN_TRADE_USDC || !(shares > 0)) return null;
  const priceUsd = usdcSize / shares;
  return Number.isFinite(priceUsd) && priceUsd > 0 ? { signature, blockTime: tx.blockTime, priceUsd, usdcSize } : null;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Median of the nearest `ENTRY_PRICE_TRADES` trades in the hour before the deposit. */
export function entryPriceFromTrades(trades: readonly PoolTrade[], depositBlockTime: number): EntryPriceResult {
  const nearest = trades
    .filter((trade) => trade.blockTime <= depositBlockTime && depositBlockTime - trade.blockTime <= ENTRY_PRICE_MAX_AGE_SECONDS)
    .sort((a, b) => b.blockTime - a.blockTime)
    .slice(0, ENTRY_PRICE_TRADES);
  if (!nearest.length) return { status: "no_trade", priceUsd: null, trades: [] };
  return { status: "ok", priceUsd: median(nearest.map((trade) => trade.priceUsd)), trades: nearest };
}
