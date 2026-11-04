import { describe, expect, it } from "vitest";
import { payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { solanaPool, type SolanaPoolRow } from "./rows";
import { summarizeApr7d, withoutNewPoolAprs, type Apr7dState } from "./apr7d";

const SNAPSHOT = "2026-11-04T08:17:54.000Z";
const NOW = Date.parse(SNAPSHOT) + 3_600_000;
/** AMZNx/AMZN `8ug1sF…` on 2026-11-04: Tight 122.84% from 6 days since launch (one launch day ≈ 83% of the volume). */
const amzn = (days: number) => {
  const payload = payloadWithAprs({ tight: 122.84 });
  payload.sample = { ...payload.sample, days };
  payload.freshness = { snapshotAt: SNAPSHOT, chainObservedAt: SNAPSHOT, volumeObservedAt: SNAPSHOT, stale: false };
  return payload;
};

describe("summarizeApr7d: 7-day minimum", () => {
  it("under 7 days of data is a new pool with its day count and no APR", () => {
    const state = summarizeApr7d(amzn(6), "raydium-clmm", NOW);
    expect(state).toMatchObject({ status: "new", days: 6 });
    expect(state).not.toHaveProperty("aprPct");
    expect(summarizeApr7d(amzn(1), "raydium-clmm", NOW)).toMatchObject({ status: "new", days: 1 });
  });
  it("7 days shows the APR as before", () => {
    expect(summarizeApr7d(amzn(7), "raydium-clmm", NOW)).toMatchObject({ status: "ready", aprPct: 122.84 });
  });
  it("an expired snapshot stays '—' (missing), whatever its day count", () => {
    expect(summarizeApr7d(amzn(6), "raydium-clmm", Date.parse(SNAPSHOT) + 49 * 3_600_000).status).toBe("missing");
  });
});

describe("withoutNewPoolAprs", () => {
  const row = (poolAddress: string) => solanaPool({
    poolAddress, mintA: `${poolAddress}-a`, mintB: `${poolAddress}-b`, symbolA: "AMZNx", symbolB: "AMZN", wrappedSymbol: "AMZNx",
    plainSymbol: "AMZN", feeTierBps: 25, tvlUsd: 1238, volume24hUsd: 9, estimatedFeeAprPct: 0.67, token2022A: true, token2022B: true,
    nameA: "a", nameB: "b", wrapKind: "suffix-x",
  } as unknown as SolanaPoolRow);
  it("blanks only a new pool's 24h APR, so it shows no APR and sorts last", () => {
    const young = row("young"), old = row("old");
    const apr: Record<string, Apr7dState> = { [young.key]: { status: "new", days: 6 }, [old.key]: { status: "loading" } };
    const [y, o] = withoutNewPoolAprs([young, old], apr);
    expect(y!.poolFeeApr24hPct).toBeNull();
    expect(o).toBe(old);
  });
});
