import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), figures: vi.fn(), prices: vi.fn(), metadata: vi.fn(), symbols: vi.fn(), rpc: vi.fn(), reset: vi.fn(),
  storeRequest: vi.fn(), getStore: vi.fn(), sync: vi.fn(), historyEnabled: { value: true } }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: mocks.rpc }));
vi.mock("@sofinance/engine/rpc/cache", () => ({ resetRpcCache: mocks.reset }));
vi.mock("@sofinance/engine/protocols/raydium/position-snapshot", () => ({ readRaydiumPositionAccounts: mocks.snapshot }));
vi.mock("@sofinance/engine/token-prices", () => ({ fetchTokenPricesUsd: mocks.prices }));
vi.mock("@sofinance/engine/token-metadata", () => ({ getTokenMetadata: mocks.metadata }));
vi.mock("@/lib/position-performance", () => ({ getPositionFigures: mocks.figures, fetchRaydiumPoolSymbolsBatch: mocks.symbols }));
vi.mock("@/lib/config/rwa-env", () => ({ getRwaConfig: () => ({ positionHistoryEnabled: mocks.historyEnabled.value }) }));
vi.mock("@/lib/position-history-store", () => ({ getPositionHistoryStore: mocks.getStore }));
vi.mock("@/lib/position-history-sync", () => ({ syncPositionHistory: mocks.sync }));
vi.mock("@/lib/position-history-rpc", () => ({ createHistoryRpcConnections: vi.fn() }));
import { readPortfolio } from "./portfolio.server";
import { PositionHistoryStoreError } from "@/lib/position-history-store-types";

const mint = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const key = (n: number) => `raydium-clmm:${mint(n)}`;
const signal = () => new AbortController().signal;
const live = { stock: null, shares: null, valueUsd: 0.64, unclaimedFeesUsd: 0.0006 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.historyEnabled.value = true;
  mocks.rpc.mockReturnValue({});
  mocks.snapshot.mockImplementation(async () => ({ poolId: "pool", mintA: "A", mintB: "B", positionAccount: "acct", vaultA: "va", vaultB: "vb" }));
  mocks.prices.mockResolvedValue(new Map());
  mocks.metadata.mockResolvedValue({});
  mocks.symbols.mockResolvedValue(new Map([["pool", { symbolA: "USDC", symbolB: "USDT" }]]));
  mocks.getStore.mockReturnValue({ request: mocks.storeRequest });
  // Like the real valuation: cumulative fees need a complete ledger, value and unclaimed fees do not.
  mocks.figures.mockImplementation(async (_mint: string, options: { historyResult?: { truncated: boolean } }) => {
    const complete = options.historyResult ? !options.historyResult.truncated : true;
    return { figures: { ...live, cumulativeFeesUsd: complete ? 1 : null }, evaluatedAt: "2026-11-26T12:45:01.000Z",
      historyComplete: complete, historyRefreshResolved: complete, timings: {}, historyFetch: {} };
  });
});

describe("Portfolio when the position-history store is down", () => {
  it.each(["POSITION_STORE_UNAVAILABLE", "POSITION_HISTORY_TOO_LARGE"])("keeps value and unclaimed fees, drops only cumulative fees, and carries %s", async (code) => {
    mocks.storeRequest.mockRejectedValue(new PositionHistoryStoreError(code));
    const schedule = vi.fn();
    const result = await readPortfolio({ wallet: mint(7), positions: [{ key: key(1) }, { key: key(2) }], scheduleHistoryRefresh: schedule }, signal());
    expect(result.positions).toHaveLength(2);
    for (const row of result.positions) {
      expect(row).toMatchObject({ status: "partial", historyStatus: "unavailable", historyError: code, historyComplete: false, historyRefreshResolved: false,
        figures: { valueUsd: 0.64, unclaimedFeesUsd: 0.0006, cumulativeFeesUsd: null } });
    }
    // Totals: value and unclaimed add up; the cumulative dash counts as catching up, not as a missing position.
    expect(result.totals).toMatchObject({ valueUsd: 1.28, cumulativeFeesUsd: null, missing: 0, cumulativePending: 2 });
    // The valuation is told there is no store (it must not read it again), and no background sync is scheduled.
    expect(mocks.figures).toHaveBeenCalledWith(mint(1), expect.objectContaining({ historyStore: null,
      historyResult: expect.objectContaining({ truncated: true, history: [] }) }));
    expect(schedule).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("also degrades when opening the store itself throws the store's error", async () => {
    mocks.getStore.mockImplementation(() => { throw new PositionHistoryStoreError("POSITION_STORE_UNAVAILABLE"); });
    const result = await readPortfolio({ wallet: mint(7), positions: [{ key: key(1) }], scheduleHistoryRefresh: vi.fn() }, signal());
    expect(result.positions[0]).toMatchObject({ status: "partial", historyError: "POSITION_STORE_UNAVAILABLE", figures: { valueUsd: 0.64, cumulativeFeesUsd: null } });
  });

  it("does not hide other failures: an unrelated error still fails the row", async () => {
    mocks.storeRequest.mockRejectedValue(new Error("unexpected"));
    const result = await readPortfolio({ wallet: mint(7), positions: [{ key: key(1) }], scheduleHistoryRefresh: vi.fn() }, signal());
    expect(result.positions[0]).toMatchObject({ status: "failed", figures: { valueUsd: null } });
    expect(result.positions[0]).not.toHaveProperty("historyError");
  });

  it("leaves a healthy store unchanged: complete history, no historyError, no forced store override", async () => {
    mocks.storeRequest.mockResolvedValue({ readAt: new Date().toISOString(), snapshot: null });
    const result = await readPortfolio({ wallet: mint(7), positions: [{ key: key(1) }], scheduleHistoryRefresh: vi.fn() }, signal());
    expect(result.positions[0]).not.toHaveProperty("historyError");
    expect(result.positions[0]).toMatchObject({ historyStatus: "updating" });
    expect(mocks.figures.mock.calls[0]![1]).not.toHaveProperty("historyStore");
  });
});
