import "server-only";
/**
 * Shares put in and their average deposit-time price for the Performance stock view.
 * Prices are recorded once per deposit (`position_entry_prices`): a read uses stored rows (`ok` at any method
 * version; current-version `no_trade`), looks up at most `MAX_ENTRY_PRICE_LOOKUPS_PER_READ` missing deposits
 * (including old-version `no_trade`) over the history transport, stores the definite results, and leaves the rest
 * for a later view. Each lookup is one signatures call plus at most 40 transactions; the whole read is budgeted at
 * `LOOKUP_BUDGET_MS`. No store means no lookups: an unrecorded price is never recomputed per view.
 * Never throws.
 */
import { createHistoryRpcConnections } from "./position-history-rpc";
import { averageCost, costBasisSteps, depositsNeedingPrice, type CostBasisDeposit, type CostBasisHistoryItem, type StockEntry } from "./stock-cost-basis";
import { entryPriceRpc, lookupDepositEntryPrice, type EntryPriceRpc } from "./stock-entry-price-lookup";
import { getStockEntryPriceStore } from "./stock-entry-price-store";
import {
  MAX_ENTRY_PRICE_READ, MAX_ENTRY_PRICE_WRITE, STOCK_ENTRY_PRICE_METHOD_VERSION, type StockEntryPriceRow, type StockEntryPriceStore,
} from "./stock-entry-price-store-types";
import { ENTRY_PRICE_TRADES } from "./stock-entry-price-trades";
import { stockReferencePool, type StockReferencePool } from "./stock-reference-pools";

export const MAX_ENTRY_PRICE_LOOKUPS_PER_READ = 4;
/** Wall-clock budget for the lookups in one read. Four lookups at up to 41 RPC each still fit when groups of four run in parallel. */
export const LOOKUP_BUDGET_MS = 15_000;
/** The one temporary reason; every other missing price is "not recorded" (the stock view's default reason). */
export const ENTRY_PRICE_PENDING_REASON = "Entry price is still being recorded; it appears on a later view.";

export type { StockEntry };
export type StockEntryDeps = { store?: StockEntryPriceStore | null; rpc?: EntryPriceRpc };
export type StockEntryInput = {
  history: readonly CostBasisHistoryItem[];
  positionId: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  baseSide: "A" | "B";
  uiPriceBPerA: number;
  signal?: AbortSignal;
  deps?: StockEntryDeps;
};

const chunks = <T>(items: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

function openStore(deps: StockEntryDeps | undefined): StockEntryPriceStore | null {
  if (deps && "store" in deps) return deps.store ?? null;
  try { return getStockEntryPriceStore(); } catch { return null; }
}

async function lookUpMissing(store: StockEntryPriceStore, ref: StockReferencePool, missing: readonly CostBasisDeposit[],
  input: StockEntryInput): Promise<StockEntryPriceRow[]> {
  const budget = AbortSignal.timeout(LOOKUP_BUDGET_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, budget]) : budget;
  let rpc = input.deps?.rpc;
  try { rpc ??= entryPriceRpc(createHistoryRpcConnections(signal).connection); } catch { return []; }
  const settled = await Promise.allSettled(missing.map(async (deposit): Promise<StockEntryPriceRow> => {
    const result = await lookupDepositEntryPrice(rpc, ref, { signature: deposit.signature, blockTime: deposit.blockTime! }, signal);
    const base = { depositSignature: deposit.signature, priceMint: ref.mint, depositSlot: deposit.slot, depositBlockTime: deposit.blockTime!,
      referencePool: ref.pool, methodVersion: STOCK_ENTRY_PRICE_METHOD_VERSION };
    return result.status === "ok" ? { ...base, status: "ok", priceUsd: result.priceUsd, trades: result.trades }
      : { ...base, status: "no_trade", priceUsd: null, trades: [] };
  }));
  const rows = settled.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
  // Definite results are stored once; a failed write only means this view's lookups are repeated next time.
  for (const batch of chunks(rows, MAX_ENTRY_PRICE_WRITE)) await store.request({ op: "write", rows: batch }).catch(() => 0);
  return rows;
}

/**
 * Null when there is nothing to price (no deposit in the history). A missing price has reason `ENTRY_PRICE_PENDING_REASON`
 * while a later view can still record it, else null ("not recorded": no listed pool, no trade in the hour, no store).
 */
export async function resolveStockEntry(input: StockEntryInput): Promise<StockEntry | null> {
  try {
    const steps = costBasisSteps(input.history, input);
    if (!steps.length) return null;
    const needed = depositsNeedingPrice(steps);
    const { sharesIn } = averageCost(steps, new Map());
    const unpriced = (reason: string | null = null): StockEntry => ({ sharesIn, entryPriceUsd: null, source: null, reason });
    // The report's share amounts are in base-side units, so only the base mint's own USDC pool prices them.
    const ref = stockReferencePool(input.baseSide === "A" ? input.mintA : input.mintB);
    if (!needed.length || !ref || needed.some((deposit) => deposit.blockTime === null)) return unpriced();
    const store = openStore(input.deps);
    if (!store) return unpriced();
    const rows: StockEntryPriceRow[] = [];
    try {
      for (const batch of chunks(needed.map((deposit) => deposit.signature), MAX_ENTRY_PRICE_READ))
        rows.push(...await store.request({ op: "read", priceMint: ref.mint, methodVersion: STOCK_ENTRY_PRICE_METHOD_VERSION, signatures: batch }));
    } catch {
      // Without the stored rows a lookup could repeat recorded work: skip lookups this view.
      return unpriced(ENTRY_PRICE_PENDING_REASON);
    }
    const stored = new Set(rows.map((row) => row.depositSignature));
    const missing = needed.filter((deposit) => !stored.has(deposit.signature));
    if (missing.length) rows.push(...await lookUpMissing(store, ref, missing.slice(0, MAX_ENTRY_PRICE_LOOKUPS_PER_READ), input));
    const basis = averageCost(steps, new Map(rows.flatMap((row) => row.status === "ok" ? [[row.depositSignature, row.priceUsd] as const] : [])));
    if (basis.entryPriceUsd !== null) return { sharesIn: basis.sharesIn, entryPriceUsd: basis.entryPriceUsd, reason: null,
      source: `Median of the ${ENTRY_PRICE_TRADES} nearest ${ref.symbol}/USDC trades in the hour before each deposit (pool ${ref.pool})` };
    return unpriced(rows.some((row) => row.status === "no_trade") ? null : ENTRY_PRICE_PENDING_REASON);
  } catch {
    return null;
  }
}
