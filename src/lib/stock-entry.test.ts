import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import fixture from "./fixtures/stock-entry-price-nvda.json";
import type { TokenNativeMetrics } from "@sofinance/engine/position-performance-math";
import type { PositionCashflowEvent } from "./position-performance-events";
import { buildStockPerformance } from "./stock-performance-build";
import { ENTRY_PRICE_PENDING_REASON, MAX_ENTRY_PRICE_LOOKUPS_PER_READ, resolveStockEntry, type StockEntryInput } from "./stock-entry";
import { lookupDepositEntryPrice, type EntryPriceRpc } from "./stock-entry-price-lookup";
import {
  canReplaceEntryPriceRow, entryPriceStoreRequestSchema, isReusableEntryPriceRow, STOCK_ENTRY_PRICE_METHOD_VERSION,
  type EntryPriceStoreRequest, type StockEntryPriceRow, type StockEntryPriceStore,
} from "./stock-entry-price-store-types";
import type { RawPoolTransaction } from "./stock-entry-price-trades";
import { stockReferencePool, type StockReferencePool } from "./stock-reference-pools";

const NVDA = "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv";
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const POOL = "FjUosHaSbH6XWodwzNfq2bFeSJkmdLkwi66zBjzc8KKS";
const POSITION = "2Q8xUv6AaRo3tPb1SjToizHEyYwumgYPU5GM1PtmBsuo";
const deposit = fixture.deposit;
/** The NVDAx/USDC pool of the original example: not in the static map (xStocks are never a report's base side). */
const NVDAX_REF: StockReferencePool = { mint: NVDAX, symbol: "NVDAx", protocol: "raydium-clmm", pool: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6",
  stockVault: "DyKsypuzQvhi37K8UvjCMBC43h4HtW4r6jhWoqHyrSSe", usdcVault: "4JEtq7NraU9U5URcCKSv6sWRRgDSuSnUjYDqpSJSWohY" };

/** Serves the fixture's two reference pools; every deposit gets the same page (the fixture's). */
function fixtureRpc(options: { fail?: boolean; unsupported?: string[] } = {}) {
  const calls: string[] = [];
  const pools = Object.values(fixture.pools);
  const rpc: EntryPriceRpc = {
    async signaturesBefore(pool, _before, limit) {
      calls.push(`signatures:${pool}`);
      if (options.fail) throw new Error("429");
      return pools.find((item) => item.pool === pool)!.signatures.slice(0, limit);
    },
    async transaction(signature) {
      calls.push(`transaction:${signature}`);
      if (options.unsupported?.includes(signature)) return null;
      const tx = pools.map((item) => (item.transactions as unknown as Record<string, RawPoolTransaction>)[signature]).find(Boolean);
      return tx ? { ...tx } : null;
    },
  };
  return { rpc, calls };
}

function memoryStore() {
  const rows = new Map<string, StockEntryPriceRow>();
  const requests: EntryPriceStoreRequest[] = [];
  const store: StockEntryPriceStore = {
    async request(input) {
      const parsed = entryPriceStoreRequestSchema.parse(input) as EntryPriceStoreRequest;
      requests.push(parsed);
      if (parsed.op === "read") return parsed.signatures.flatMap((signature) => {
        const row = rows.get(`${signature}:${parsed.priceMint}`);
        return row && isReusableEntryPriceRow(row, parsed.methodVersion) ? [row] : [];
      }) as never;
      let written = 0;
      for (const row of parsed.rows) {
        const key = `${row.depositSignature}:${row.priceMint}`;
        const existing = rows.get(key);
        if (!existing || canReplaceEntryPriceRow(existing, row)) { rows.set(key, row); written++; }
      }
      return written as never;
    },
  };
  return { store, rows, requests };
}

const open: PositionCashflowEvent = { kind: "open", poolState: POOL, nftOwner: "Owner1111111111111111111111111111111111111",
  tickLower: 45960, tickUpper: 46140, liquidity: "734079211", amountA: "344847", amountB: "31431638" };
const history = [{ signature: deposit.signature, slot: deposit.slot, blockTime: deposit.blockTime, events: [open] }];
const entryInput = (overrides: Partial<StockEntryInput> = {}): StockEntryInput => ({
  history, positionId: POSITION, poolId: POOL, mintA: NVDA, mintB: NVDAX, decimalsA: 6, decimalsB: 8,
  baseSide: "A", uiPriceBPerA: 0.9995, ...overrides,
});

describe("lookupDepositEntryPrice on the NVDA example", () => {
  it("NVDA/USDC (base side): groups of 4 until 3 trades, the median of the trades 2, 3 and 4 s before the deposit", async () => {
    const { rpc, calls } = fixtureRpc();
    const result = await lookupDepositEntryPrice(rpc, stockReferencePool(NVDA)!, deposit);
    expect(result.status).toBe("ok");
    expect(result.priceUsd).toBeCloseTo(176.998, 3);
    expect(result.rpcCalls).toBe(calls.length);
    expect(calls[0]).toMatch(/^signatures:/);
    expect(calls.slice(1).every((call) => call.startsWith("transaction:"))).toBe(true);
    expect(result.trades).toHaveLength(3);
  });

  it("NVDAx/USDC: stops after the first group of 4 transactions once 3 trades are in hand", async () => {
    const { rpc, calls } = fixtureRpc();
    const result = await lookupDepositEntryPrice(rpc, NVDAX_REF, deposit);
    expect(result.rpcCalls).toBe(5);
    expect(calls).toHaveLength(5);
    expect(result.priceUsd).toBeCloseTo(177.4288, 4);
  });

  it("skips a transaction the node cannot return in a supported version", async () => {
    const first = fixture.pools.NVDAx.signatures[0]!.signature;
    const { rpc } = fixtureRpc({ unsupported: [first] });
    const result = await lookupDepositEntryPrice(rpc, NVDAX_REF, deposit);
    expect(result.trades.map((trade) => trade.signature)).not.toContain(first);
    expect(result.status).toBe("ok");
  });

  it("never reads signatures from more than an hour before the deposit", async () => {
    const { rpc, calls } = fixtureRpc();
    const result = await lookupDepositEntryPrice(rpc, stockReferencePool(NVDA)!, { ...deposit, blockTime: deposit.blockTime + 3_700 });
    expect(result).toMatchObject({ status: "no_trade", priceUsd: null, rpcCalls: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe("resolveStockEntry", () => {
  it("records the deposit once: the second view reads the store and makes no RPC call", async () => {
    const { store, rows } = memoryStore();
    const first = fixtureRpc();
    const entry = await resolveStockEntry(entryInput({ deps: { store, rpc: first.rpc } }));
    expect(entry?.entryPriceUsd).toBeCloseTo(176.998, 3);
    expect(entry?.sharesIn).toBeCloseTo(0.344847 + 0.31431638 / 0.9995, 9);
    expect(entry?.source).toMatch(/NVDA\/USDC trades in the hour before each deposit/);
    expect(first.calls[0]).toMatch(/^signatures:/);
    expect(first.calls.length).toBeGreaterThan(1);
    expect([...rows.values()]).toMatchObject([{ depositSignature: deposit.signature, priceMint: NVDA, status: "ok",
      referencePool: fixture.pools.NVDA.pool, depositSlot: deposit.slot, depositBlockTime: deposit.blockTime }]);
    const second = fixtureRpc();
    expect((await resolveStockEntry(entryInput({ deps: { store, rpc: second.rpc } })))?.entryPriceUsd).toBe(entry?.entryPriceUsd);
    expect(second.calls).toHaveLength(0);
  });

  it("has no entry price, and makes no RPC call or store read, when the base mint has no listed pool", async () => {
    const { store, requests } = memoryStore();
    const { rpc, calls } = fixtureRpc();
    const entry = await resolveStockEntry(entryInput({ mintA: "Plain11111111111111111111111111111111111111", deps: { store, rpc } }));
    expect(entry).toMatchObject({ entryPriceUsd: null, reason: null });
    expect(entry?.sharesIn).toBeGreaterThan(0);
    expect([calls.length, requests.length]).toEqual([0, 0]);
  });

  it(`looks up at most ${MAX_ENTRY_PRICE_LOOKUPS_PER_READ} deposits per view and finishes on the next`, async () => {
    const { store, rows } = memoryStore();
    const increases = Array.from({ length: 5 }, (_, index) => ({
      signature: `${deposit.signature.slice(0, -4)}${String(index + 1).padStart(4, "1")}`, slot: deposit.slot + index + 1,
      blockTime: deposit.blockTime, events: [{ kind: "increase", positionNftMint: POSITION, liquidity: "1", amountA: "1000000", amountB: "0" } as PositionCashflowEvent],
    }));
    const first = await resolveStockEntry(entryInput({ history: [...history, ...increases], deps: { store, rpc: fixtureRpc().rpc } }));
    expect(rows.size).toBe(4);
    expect(first).toMatchObject({ entryPriceUsd: null, reason: ENTRY_PRICE_PENDING_REASON });
    const second = fixtureRpc();
    const done = await resolveStockEntry(entryInput({ history: [...history, ...increases], deps: { store, rpc: second.rpc } }));
    expect(rows.size).toBe(6);
    expect(second.calls.filter((call) => call.startsWith("signatures:"))).toHaveLength(2);
    expect(done?.entryPriceUsd).not.toBeNull();
  });

  it("stores nothing on an RPC failure, and makes no lookup without a store", async () => {
    const { store, rows, requests } = memoryStore();
    const failing = fixtureRpc({ fail: true });
    expect((await resolveStockEntry(entryInput({ deps: { store, rpc: failing.rpc } })))?.reason).toBe(ENTRY_PRICE_PENDING_REASON);
    expect(rows.size).toBe(0);
    expect(requests.map((request) => request.op)).toEqual(["read"]);
    const unused = fixtureRpc();
    expect(await resolveStockEntry(entryInput({ deps: { store: null, rpc: unused.rpc } })))
      .toMatchObject({ entryPriceUsd: null, reason: null });
    expect(unused.calls).toHaveLength(0);
  });

  it("records a deposit with no trade in the hour before it as not recorded, for good", async () => {
    const { store, rows } = memoryStore();
    const late = [{ ...history[0]!, blockTime: deposit.blockTime + 3_700 }];
    const entry = await resolveStockEntry(entryInput({ history: late, deps: { store, rpc: fixtureRpc().rpc } }));
    expect([...rows.values()][0]).toMatchObject({ status: "no_trade", priceUsd: null, trades: [] });
    expect(entry).toMatchObject({ entryPriceUsd: null, reason: null });
  });
  it("looks up again when a stored no_trade is from an older method version, and leaves an older ok alone", async () => {
    const { store, rows } = memoryStore();
    const key = `${deposit.signature}:${NVDA}`;
    rows.set(key, { depositSignature: deposit.signature, priceMint: NVDA, depositSlot: deposit.slot,
      depositBlockTime: deposit.blockTime, referencePool: fixture.pools.NVDA.pool, methodVersion: 1,
      status: "no_trade", priceUsd: null, trades: [] });
    const recompute = fixtureRpc();
    const entry = await resolveStockEntry(entryInput({ deps: { store, rpc: recompute.rpc } }));
    expect(entry?.entryPriceUsd).toBeCloseTo(176.998, 3);
    expect(recompute.calls.length).toBeGreaterThan(1);
    expect(rows.get(key)).toMatchObject({ status: "ok", methodVersion: STOCK_ENTRY_PRICE_METHOD_VERSION });
    const ok = fixtureRpc();
    rows.set(key, { ...rows.get(key)!, methodVersion: 1, status: "ok", priceUsd: 176.998,
      trades: [{ signature: "t".repeat(64), blockTime: deposit.blockTime - 2, priceUsd: 176.998, usdcSize: 10 }] });
    const kept = await resolveStockEntry(entryInput({ deps: { store, rpc: ok.rpc } }));
    expect(kept?.entryPriceUsd).toBeCloseTo(176.998, 3);
    expect(ok.calls).toHaveLength(0);
    expect(rows.get(key)?.methodVersion).toBe(1);
  });
});

it("fills price change and total for the NVDA position from the recorded entry price", async () => {
  const { store } = memoryStore();
  const stock = await buildStockPerformance({
    history, positionId: POSITION, poolId: POOL, mintA: NVDA, mintB: NVDAX, decimalsA: 6, decimalsB: 8,
    tokenNative: { tokenEquivalent: { baseSymbol: "NVDA", baseSide: "A", uiPriceBPerA: 0.9995,
      metrics: { equity: 0.66, feesEarned: 0.01 } } } as TokenNativeMetrics,
    metrics: { currentEquityUsd: 118.8, feesEarnedUsd: 1.8 }, incomplete: false, nowSeconds: deposit.blockTime + 86_400,
    quotes: new Map([[NVDA, { source: "jupiter" as const, price: 180, priceChange24hPct: 1, liquidityUsd: 1 }]]),
    entryDeps: { store, rpc: fixtureRpc().rpc },
  });
  const sharesIn = 0.344847 + 0.31431638 / 0.9995;
  expect(stock?.entryPriceUsd).toBeCloseTo(176.998, 3);
  expect(stock?.sharesIn).toBeCloseTo(sharesIn, 9);
  expect(stock?.priceChangeUsd).toBeCloseTo(sharesIn * (180 - stock!.entryPriceUsd!), 9);
  expect(stock?.priceChangePct).toBeCloseTo((180 / stock!.entryPriceUsd! - 1) * 100, 9);
  expect(stock?.totalUsd).toBeCloseTo(stock!.priceChangeUsd! + 1.8, 9);
  expect(stock?.entryUnavailableReason).toBeNull();
});
