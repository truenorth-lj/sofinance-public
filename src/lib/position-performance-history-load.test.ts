import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ sync: vi.fn(), fetch: vi.fn(), parse: vi.fn() }));
vi.mock("./position-history-sync", () => ({ syncPositionHistory: mocks.sync }));
vi.mock("./position-performance-history", async original => ({ ...(await original<typeof import("./position-performance-history")>()), fetchPositionHistoryTransactions: mocks.fetch }));
vi.mock("./position-performance-events", async original => ({ ...(await original<typeof import("./position-performance-events")>()), parsePositionCashflowEvents: mocks.parse }));
import { loadPerformanceHistory } from "./position-performance-history-load";
import { resetPositionHistoryCache } from "./position-history-cache";
import type { SyncedPositionHistory } from "./position-history-sync";
const context = { positionMint: "1".repeat(32), positionAccount: "2".repeat(32), poolId: "3".repeat(32),
  mintA: "4".repeat(32), mintB: "5".repeat(32), vaultA: "6".repeat(32), vaultB: "7".repeat(32) };
const statuses = vi.fn();
const connection = { getParsedTransaction: vi.fn(), getSignaturesForAddress: vi.fn(), getSignatureStatuses: statuses };
const input = { address: PublicKey.unique(), context, connection, provider: "default" as const,
  maxSignatures: 100, store: { request: vi.fn() } };
const result = (): SyncedPositionHistory => ({ history: [{ signature: "old", slot: 1, blockTime: 1, events: [] }],
  signatureCount: 1, truncated: false, metric: { source: "databaseIncremental", provider: "default", txCount: 1,
    elapsedMs: 1, solamiTxCount: 0, defaultTxCount: 0, fallbackReasons: [], historyComplete: true } });
beforeEach(() => { resetPositionHistoryCache(); vi.resetAllMocks(); mocks.sync.mockImplementation(async () => result()); });
describe("short cache with transaction refresh", () => {
  it("skips database sync on repeat reads and misses on a changed position account", async () => {
    await loadPerformanceHistory({ ...input, stateFingerprint: "before" });
    expect((await loadPerformanceHistory({ ...input, stateFingerprint: "before" })).metric.memoryCacheHit).toBe(true);
    await loadPerformanceHistory({ ...input, stateFingerprint: "after" });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });
  it("forces another instance's cached baseline fresh and suppresses returns until all required signatures resolve", async () => {
    await loadPerformanceHistory(input);
    statuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] });
    const pending = await loadPerformanceHistory({ ...input, afterSignatures: ["new"] });
    expect(pending).toMatchObject({ truncated: true, metric: { refreshSignaturesResolved: false, historyComplete: false, canContinue: false } });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    mocks.sync.mockImplementation(async () => ({ ...result(), history: [{ signature: "new", slot: 2, blockTime: 2, events: [] }] }));
    expect((await loadPerformanceHistory({ ...input, afterSignatures: ["new"] })).metric.refreshSignaturesResolved).toBe(true);
    expect(mocks.sync).toHaveBeenCalledTimes(3);
  });
  it("only acknowledges a missing failed transaction after finalized failure", async () => {
    statuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: { Custom: 1 } }] });
    expect((await loadPerformanceHistory({ ...input, afterSignatures: ["new"] })).truncated).toBe(true);
    statuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: { Custom: 1 } }] });
    expect((await loadPerformanceHistory({ ...input, afterSignatures: ["new"] })).metric.refreshSignaturesResolved).toBe(true);
  });
  it("uses the shared loader's signal rather than the first viewer's RPC connection", async () => {
    const firstViewer = new AbortController();
    const sharedConnection = { ...connection };
    const factory = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(false); return { connection: sharedConnection }; });
    await loadPerformanceHistory({ ...input, signal: firstViewer.signal, connectionsForSignal: factory });
    expect(factory.mock.calls[0]?.[0]).not.toBe(firstViewer.signal);
    expect(mocks.sync.mock.calls[0]?.[0].connection).toBe(sharedConnection);
    expect(mocks.sync.mock.calls[0]?.[0].signal).toBe(factory.mock.calls[0]?.[0]);
  });
  it("forwards request-scoped RPC observers only to a new shared history load", async () => {
    const rpcMetrics = vi.fn(() => ({ attemptCount: 1, rateLimitCount: 0, queuedMs: 2,
      requestMs: 3, maxActive: 1, primaryAttempts: 0, defaultAttempts: 1, responseBytes: 100 }));
    const receiptProvider = vi.fn(() => "default" as const);
    const factory = vi.fn(() => ({ connection, rpcMetrics, receiptProvider }));
    await loadPerformanceHistory({ ...input, maxDetailRequests: 100, connectionsForSignal: factory });
    expect(mocks.sync.mock.calls[0]?.[0]).toMatchObject({ rpcMetrics, receiptProvider, maxDetailRequests: 100 });
    const hit = await loadPerformanceHistory({ ...input, maxDetailRequests: 100, connectionsForSignal: factory });
    expect(hit.metric.memoryCacheHit).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });
  it("includes required-signature status checks in final RPC telemetry", async () => {
    let attemptCount = 1;
    statuses.mockImplementation(async () => { attemptCount++; return { value: [{ confirmationStatus: "finalized", err: {} }] }; });
    const rpcMetrics = () => ({ attemptCount, rateLimitCount: 0, queuedMs: 0, requestMs: 0,
      maxActive: 1, primaryAttempts: 0, defaultAttempts: attemptCount, responseBytes: 100 });
    const response = await loadPerformanceHistory({ ...input, afterSignatures: ["new"],
      connectionsForSignal: () => ({ connection, rpcMetrics }) });
    expect(response.metric.refreshSignaturesResolved).toBe(true);
    expect(response.metric.rpc?.attemptCount).toBe(2);
  });
  it("resolves required signatures in the legacy flag-off reader too", async () => {
    mocks.fetch.mockResolvedValue({ items: [{ signature: "new", slot: 1, blockTime: 1, logMessages: [], parsedTransaction: {} }],
      signatureCount: 1, truncated: false, metric: result().metric });
    mocks.parse.mockReturnValue([{ kind: "increase", positionNftMint: context.positionMint }]);
    expect((await loadPerformanceHistory({ ...input, store: null, afterSignatures: ["new"] })).metric.refreshSignaturesResolved).toBe(true);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
