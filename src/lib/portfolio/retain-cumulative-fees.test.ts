import { describe, expect, it, beforeEach } from "vitest";
import type { PortfolioPosition } from "./model";
import { retainCumulativeFees, resetRetainedCumulativeFees } from "./retain-cumulative-fees";

const key = "raydium-clmm:11111111111111111111111111111111";
const figures = (over: Partial<PortfolioPosition["figures"]> = {}): PortfolioPosition["figures"] => ({
  stock: "SPCX", shares: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: null, ...over,
});
const base = (over: Partial<Omit<PortfolioPosition, "figures">> & { figures?: Partial<PortfolioPosition["figures"]> } = {}): PortfolioPosition => ({
  key, status: "partial", evaluatedAt: "2026-11-21T00:00:00Z", historyComplete: false, historyRefreshResolved: false,
  ...over, figures: figures(over.figures),
});

describe("retainCumulativeFees", () => {
  beforeEach(() => resetRetainedCumulativeFees());

  it("keeps the last complete cumulative fee while a later read is still updating", () => {
    const complete = base({ status: "ready", historyComplete: true, historyStatus: "fresh", figures: { cumulativeFeesUsd: 11.36 } });
    expect(retainCumulativeFees("A", complete).figures.cumulativeFeesUsd).toBe(11.36);
    const updating = base({ historyStatus: "updating", figures: { valueUsd: 120, unclaimedFeesUsd: 0, cumulativeFeesUsd: null } });
    const kept = retainCumulativeFees("A", updating);
    expect(kept.figures.cumulativeFeesUsd).toBe(11.36);
    expect(kept.retained).toBe(true);
    expect(retainCumulativeFees("A", { ...updating, historyStatus: "stale" })).toMatchObject({ retained: true, figures: { cumulativeFeesUsd: 11.36 } });
    expect(retainCumulativeFees("A", { ...updating, historyStatus: "unavailable" })).toMatchObject({ retained: true, figures: { cumulativeFeesUsd: 11.36 } });
  });

  it("leaves a dash when the position has never had a complete cumulative fee", () => {
    const updating = base({ historyStatus: "updating", figures: { cumulativeFeesUsd: null } });
    expect(retainCumulativeFees("A", updating).figures.cumulativeFeesUsd).toBeNull();
  });

  it("does not backfill a null when history is fresh or missing, even if a last complete value was cached", () => {
    retainCumulativeFees("A", base({ status: "ready", historyComplete: true, historyStatus: "fresh", figures: { cumulativeFeesUsd: 11.36 } }));
    const fresh = retainCumulativeFees("A", base({ historyStatus: "fresh", figures: { cumulativeFeesUsd: null } }));
    expect(fresh.figures.cumulativeFeesUsd).toBeNull();
    expect(fresh.retained).toBeFalsy();
    const absent = retainCumulativeFees("A", base({ figures: { cumulativeFeesUsd: null } }));
    expect(absent.figures.cumulativeFeesUsd).toBeNull();
    expect(absent.retained).toBeFalsy();
  });

  it("does not reuse one wallet or position's complete value for another", () => {
    retainCumulativeFees("A", base({ status: "ready", historyComplete: true, figures: { cumulativeFeesUsd: 11.36 } }));
    expect(retainCumulativeFees("B", base({ historyStatus: "updating" })).figures.cumulativeFeesUsd).toBeNull();
    expect(retainCumulativeFees("A", base({ key: "raydium-clmm:22222222222222222222222222222222", historyStatus: "updating" })).figures.cumulativeFeesUsd).toBeNull();
  });

  it("does not apply a cached value to a failed row", () => {
    retainCumulativeFees("A", base({ status: "ready", historyComplete: true, figures: { cumulativeFeesUsd: 11.36 } }));
    const failed = base({ status: "failed", historyComplete: false, figures: { valueUsd: null, unclaimedFeesUsd: null, cumulativeFeesUsd: null } });
    expect(retainCumulativeFees("A", failed).figures.cumulativeFeesUsd).toBeNull();
  });
});
