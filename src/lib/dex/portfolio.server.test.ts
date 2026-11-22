import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), figures: vi.fn(), prices: vi.fn(), metadata: vi.fn(), symbols: vi.fn(), rpc: vi.fn(), reset: vi.fn(), adapter: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: mocks.rpc }));
vi.mock("@sofinance/engine/rpc/cache", () => ({ resetRpcCache: mocks.reset }));
vi.mock("@sofinance/engine/protocols/raydium/position-snapshot", () => ({ readRaydiumPositionAccounts: mocks.snapshot }));
vi.mock("@sofinance/engine/token-prices", () => ({ fetchTokenPricesUsd: mocks.prices }));
vi.mock("@sofinance/engine/token-metadata", () => ({ getTokenMetadata: mocks.metadata }));
vi.mock("@/lib/position-performance", () => ({ getPositionFigures: mocks.figures, fetchRaydiumPoolSymbolsBatch: mocks.symbols }));
import { readPortfolio } from "../dex/portfolio.server";
const mint = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const key = (n: number) => `raydium-clmm:${mint(n)}`;
const figures = { stock: "TSLA", shares: 2, valueUsd: 100, unclaimedFeesUsd: 1, cumulativeFeesUsd: 5 };
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockReturnValue({});
  mocks.snapshot.mockImplementation(async () => ({ poolId: "pool", mintA: "A", mintB: "B" }));
  mocks.prices.mockResolvedValue(new Map([["A", { price: 50, source: "jupiter", basis: "per-share" }]]));
  mocks.metadata.mockResolvedValue({});
  mocks.symbols.mockResolvedValue(new Map([["pool", { symbolA: "TSLA", symbolB: "TSLAx" }]]));
  mocks.figures.mockResolvedValue({ figures, evaluatedAt: "2026-11-15T00:00:00Z", historyComplete: true, historyRefreshResolved: true, timings: {}, historyFetch: {} });
});

describe("Portfolio aggregation", () => {
  it("batches shared prices/labels, deduplicates keys, computes totals and passes transaction freshness", async () => {
    const result = await readPortfolio({ wallet: mint(7), positions: [{ key: key(1), afterSignatures: ["receipt"] }, { key: key(2) }, { key: key(2) }], fresh: true }, signal());
    expect(result.positions.map((row) => row.key)).toEqual([key(1), key(2)]);
    expect(result.totals).toMatchObject({ positions: 2, valueUsd: 200, unclaimedFeesUsd: 2, cumulativeFeesUsd: 10, missing: 0 });
    expect(mocks.prices).toHaveBeenCalledExactlyOnceWith(["A", "B"]);
    expect(mocks.symbols).toHaveBeenCalledTimes(1); expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.figures).toHaveBeenCalledWith(mint(1), expect.objectContaining({ wallet: mint(7), prices: expect.any(Map), symbols: { symbolA: "TSLA", symbolB: "TSLAx" }, refreshHistory: true, historyAfterSignatures: ["receipt"] }));
  });
  it("limits active history reads to two, fills slots immediately and keeps request order", async () => {
    let active = 0, max = 0;
    const complete: (() => void)[] = [];
    mocks.figures.mockImplementation(() => new Promise((resolve) => {
      active++; max = Math.max(max, active);
      complete.push(() => { active--; resolve({ figures, historyComplete: true, historyRefreshResolved: true }); });
    }));
    const pending = readPortfolio({ wallet: mint(7), positions: [1, 2, 3].map((n) => ({ key: key(n) })) }, signal());
    await vi.waitFor(() => expect(complete).toHaveLength(2));
    complete[1]!();
    await vi.waitFor(() => expect(complete).toHaveLength(3));
    complete[2]!(); complete[0]!();
    expect((await pending).positions.map((row) => row.key)).toEqual([key(1), key(2), key(3)]); expect(max).toBe(2);
  });
  it("returns good rows around failures and flags a dash for incomplete fee history instead of inventing zero", async () => {
    mocks.figures.mockImplementation(async (value: string) => {
      if (value === mint(2)) throw new Error("provider URL with secret");
      return { figures: { ...figures, cumulativeFeesUsd: null }, historyComplete: false, historyRefreshResolved: false };
    });
    const result = await readPortfolio({ wallet: mint(7), positions: [1, 2, 3].map((n) => ({ key: key(n) })) }, signal());
    expect(result.positions.map((row) => row.status)).toEqual(["partial", "failed", "partial"]);
    // No historyStatus on these rows (this test does not enable the history store), so the dashes count as missing.
    // Catching-up classification is covered in figures.test.ts.
    expect(result.totals).toMatchObject({ valueUsd: 200, unclaimedFeesUsd: 2, cumulativeFeesUsd: null, missing: 3, cumulativePending: 0 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("isolates bad accounts and unknown sources, and stops dispatch after cancellation", async () => {
    mocks.snapshot.mockRejectedValue(new Error("bad account"));
    const result = await readPortfolio({ wallet: mint(7), positions: [{ key: key(1) }, { key: `unknown:${mint(2)}` }] }, signal());
    expect(result.positions.every((row) => row.status === "failed")).toBe(true);
    expect(mocks.figures).not.toHaveBeenCalled(); expect(mocks.adapter).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await readPortfolio({ wallet: mint(7), positions: [{ key: key(1) }] }, controller.signal);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  });
  it("cancels snapshot transport at its deadline and does not dispatch more physical reads", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      mocks.snapshot.mockImplementation(() => new Promise(() => {}));
      const pending = readPortfolio({ wallet: mint(7), positions: [1, 2, 3].map((n) => ({ key: key(n) })) }, signal());
      await vi.advanceTimersByTimeAsync(12_001);
      const result = await pending;
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
      expect(mocks.rpc.mock.calls[0]![1].signal.aborted).toBe(true);
      expect(result.positions.every((row) => row.status === "failed")).toBe(true);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it("cancels a slow fee sibling before reusing a slot after a fast history failure", async () => {
    let active = 0, max = 0;
    mocks.figures.mockImplementation(async (_mint: string, options: { signal: AbortSignal }) => {
      active++; max = Math.max(max, active);
      options.signal.addEventListener("abort", () => { active--; }, { once: true });
      throw new Error("History store unavailable while fee RPC is still active");
    });
    const result = await readPortfolio({ wallet: mint(7), positions: [1, 2, 3, 4, 5].map((n) => ({ key: key(n) })) }, signal());
    expect(result.positions.every((row) => row.status === "failed")).toBe(true);
    expect(max).toBeLessThanOrEqual(2); expect(active).toBe(0);
    expect(mocks.figures).toHaveBeenCalledTimes(5);
  });

});
