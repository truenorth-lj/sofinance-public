import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readPortfolioHistory, PORTFOLIO_HISTORY_TTL_MS } from "./history-snapshot";
import { POSITION_HISTORY_PARSER_VERSION, type PositionContext, type PositionHistoryReadSnapshot,
  type PositionHistoryStore, type StoredPositionTransaction } from "@/lib/position-history-store-types";

const now = Date.parse("2026-11-15T12:00:00.000Z");
const iso = (offset = 0) => new Date(now + offset).toISOString();
const signature = (char: string) => char.repeat(64);
const context: PositionContext = { positionMint: "1".repeat(32), positionAccount: "2".repeat(32),
  poolId: "3".repeat(32), mintA: "4".repeat(32), mintB: "5".repeat(32), vaultA: "6".repeat(32), vaultB: "7".repeat(32) };
const opening = (): StoredPositionTransaction => ({ signature: signature("a"), slot: 10, blockTime: 1000,
  status: "parsed", receipt: null, parserVersion: POSITION_HISTORY_PARSER_VERSION,
  events: [{ kind: "open", poolState: context.poolId, nftOwner: "8".repeat(32), tickLower: 0, tickUpper: 1,
    liquidity: "100", amountA: "20", amountB: "30" }] });
function snapshot(): PositionHistoryReadSnapshot & { readAt: string } {
  return { lease: null, state: { headSignature: signature("a"), backfillBefore: signature("a"),
    complete: true, revision: 1, parserVersion: POSITION_HISTORY_PARSER_VERSION },
  transactions: [opening()], updatedAt: iso(-1000), readAt: iso(), syncing: false };
}
function reader(value: (PositionHistoryReadSnapshot & { readAt: string }) | null) {
  const request = vi.fn(async (input: { op: string }) => {
    if (input.op !== "read") throw new Error("Foreground snapshot must not acquire or mutate a lease");
    if (!value) return { readAt: iso(), snapshot: null };
    const { readAt, ...snapshot } = value;
    return { readAt, snapshot };
  });
  return { request, store: { request: request as PositionHistoryStore["request"] } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Portfolio persisted history read", () => {
  it("serves a warm ledger with one read, zero history RPC and no lease mutation", async () => {
    const fetcher = vi.fn(() => { throw new Error("No network is allowed during a stored-history read"); });
    vi.stubGlobal("fetch", fetcher);
    const { store, request } = reader(snapshot());
    const result = await readPortfolioHistory({ store, context });
    expect(request).toHaveBeenCalledExactlyOnceWith({ op: "read", context, parserVersion: POSITION_HISTORY_PARSER_VERSION });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ historyStatus: "fresh", historyUpdatedAt: iso(-1000), needsSync: false, historyRefreshResolved: true,
      history: { truncated: false, signatureCount: 1, metric: { source: "databaseSnapshot", fetchedTxCount: 0, listingCount: 0, historyComplete: true } } });
    expect(result.history.history[0]?.signature).toBe(signature("a"));
  });

  it("keeps a complete stale ledger available while requesting incremental synchronization", async () => {
    const value = snapshot(); value.updatedAt = iso(-PORTFOLIO_HISTORY_TTL_MS);
    const result = await readPortfolioHistory({ store: reader(value).store, context });
    expect(result).toMatchObject({ historyStatus: "updating", needsSync: true, historyRefreshResolved: false,
      historyUpdatedAt: value.updatedAt, history: { truncated: false, metric: { historyComplete: true } } });
    expect(result.history.history).toHaveLength(1);
  });

  it("returns explicit incomplete history for a cold position rather than inventing a complete zero ledger", async () => {
    const result = await readPortfolioHistory({ store: reader(null).store, context, fresh: true });
    expect(result).toMatchObject({ historyStatus: "updating", needsSync: true, historyUpdatedAt: null,
      historyRefreshAfter: iso(), historyRefreshResolved: false, history: { history: [], truncated: true, metric: { historyComplete: false } } });
  });

  for (const fault of ["state-incomplete", "state-parser", "pending", "row-parser", "delta-before", "delta-head", "missing-opening"] as const) {
    it(`never calls ${fault} history complete or fresh`, async () => {
      const value = snapshot();
      if (fault === "state-incomplete") value.state.complete = false;
      if (fault === "state-parser") value.state.parserVersion++;
      if (fault === "pending") value.transactions.push({ ...opening(), signature: signature("b"), status: "pending", events: [] });
      if (fault === "row-parser") value.transactions[0]!.parserVersion++;
      if (fault === "delta-before") value.state.deltaBefore = signature("b");
      if (fault === "delta-head") value.state.deltaHead = signature("b");
      if (fault === "missing-opening") value.transactions[0]!.events = [];
      const result = await readPortfolioHistory({ store: reader(value).store, context });
      expect(result.history.truncated).toBe(true);
      expect(result.history.metric.historyComplete).toBe(false);
      expect(result.historyUpdatedAt).toBeNull();
      expect(result.historyRefreshResolved).toBe(false);
      expect(result.needsSync).toBe(true);
    });
  }

  it("does not fan out a second synchronization while a database lease is active", async () => {
    const value = snapshot(); value.syncing = true; value.updatedAt = iso(-PORTFOLIO_HISTORY_TTL_MS - 1);
    const result = await readPortfolioHistory({ store: reader(value).store, context });
    expect(result).toMatchObject({ historyStatus: "updating", needsSync: false, historyRefreshResolved: false });
    expect(result.history.history).toHaveLength(1);
  });

  it("uses the DB read time as the initial force-refresh barrier despite a different application clock", async () => {
    vi.setSystemTime(now + 120_000);
    const result = await readPortfolioHistory({ store: reader(snapshot()).store, context, fresh: true });
    expect(result.historyRefreshAfter).toBe(iso());
    expect(result.historyRefreshResolved).toBe(false);
    expect(result.needsSync).toBe(true);
  });

  it("retains the DB clock barrier when the first forced read has no stored row", async () => {
    vi.setSystemTime(now + 120_000);
    const cold = await readPortfolioHistory({ store: reader(null).store, context, fresh: true });
    expect(cold.historyRefreshAfter).toBe(iso());
    const checked = snapshot(); checked.updatedAt = iso(1000); checked.readAt = iso(2000);
    const poll = await readPortfolioHistory({ store: reader(checked).store, context, refreshAfter: cold.historyRefreshAfter });
    expect(poll.historyStatus).toBe("fresh"); expect(poll.historyRefreshResolved).toBe(true);
  });

  it("does not acknowledge old in-flight work merely because it finishes after a new refresh", async () => {
    const before = snapshot(); before.syncing = true; before.updatedAt = iso(-500);
    const initial = await readPortfolioHistory({ store: reader(before).store, context, fresh: true });
    const finished = snapshot(); finished.updatedAt = iso(-500); finished.readAt = iso(2000);
    const poll = await readPortfolioHistory({ store: reader(finished).store, context, refreshAfter: initial.historyRefreshAfter });
    expect(poll.historyRefreshAfter).toBe(initial.historyRefreshAfter);
    expect(poll.historyRefreshResolved).toBe(false);
    expect(poll.needsSync).toBe(true);
    const refreshed = snapshot(); refreshed.updatedAt = iso(1000); refreshed.readAt = iso(3000);
    const resolved = await readPortfolioHistory({ store: reader(refreshed).store, context, refreshAfter: poll.historyRefreshAfter });
    expect(resolved).toMatchObject({ historyStatus: "fresh", historyRefreshResolved: true, needsSync: false,
      historyRefreshAfter: iso() });
  });

  it("requires a requested signature in the finalized ledger even if ordinary TTL freshness passes", async () => {
    const result = await readPortfolioHistory({ store: reader(snapshot()).store, context, afterSignatures: [signature("b")] });
    expect(result.history.truncated).toBe(false);
    expect(result).toMatchObject({ historyRefreshResolved: false, historyStatus: "updating", needsSync: true });
    expect(result.history.metric.refreshSignaturesResolved).toBe(false);
  });

  it("acknowledges included cashflows and finalized failed transactions, but not an ignored signature", async () => {
    const value = snapshot();
    value.transactions.push({ ...opening(), signature: signature("b"), status: "failed", events: [] },
      { ...opening(), signature: signature("c"), status: "ignored", events: [] });
    const accepted = await readPortfolioHistory({ store: reader(value).store, context, afterSignatures: [signature("a"), signature("b")] });
    expect(accepted.historyRefreshResolved).toBe(true);
    const ignored = await readPortfolioHistory({ store: reader(value).store, context, afterSignatures: [signature("c")] });
    expect(ignored.historyRefreshResolved).toBe(false);
    expect(ignored.needsSync).toBe(true);
  });

  it("does not label a future or invalid successful-check timestamp as fresh", async () => {
    for (const time of [iso(1), "invalid"]) {
      const value = snapshot(); value.updatedAt = time;
      const result = await readPortfolioHistory({ store: reader(value).store, context });
      expect(result.historyRefreshResolved).toBe(false);
      expect(result.needsSync).toBe(true);
    }
  });

  it("propagates unavailable storage without falling back to a synchronous history scan", async () => {
    const request = vi.fn(async () => { throw new Error("storage unavailable"); });
    await expect(readPortfolioHistory({ store: { request }, context })).rejects.toThrow("storage unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
