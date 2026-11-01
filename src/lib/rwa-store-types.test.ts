import { describe, expect, it } from "vitest";
import {
  FEED_KEY,
  FEED_KEY_METEORA,
  presetCountAllowed,
  SOLANA_FEED_KEYS,
  SOLANA_FEED_PROTOCOL,
  storeRequestSchema,
} from "./rwa-store-types";

const lease = { job: "rwa-discovery", owner: "00000000-0000-4000-8000-000000000000", epoch: 1 };
const at = "2026-11-01T00:00:00.000Z";
function discovery(protocol: string | undefined, feedKey?: string) {
  const row: Record<string, unknown> = { poolAddress: "1".repeat(32), mintA: "4".repeat(32), mintB: "5".repeat(32),
    symbolA: "TESTx", symbolB: "TEST", tvlUsd: 1, volume24hUsd: 1, fees24hUsd: 1, feeRate: 0.001, estimatedFeeAprPct: 1 };
  if (protocol) row.protocol = protocol;
  return { op: "publishDiscovery", lease, data: {
    ...(feedKey ? { feedKey } : {}),
    result: { pairs: [row], pagesFetched: 1, scannedPools: 1, fetchedAt: at, source: "x", pairingRuleSummary: "x", estimatedFeeAprLabel: "x" },
    sourcePages: { ["1".repeat(32)]: 1 }, poolObservedAt: { ["1".repeat(32)]: at }, pageCounts: [1], qualificationObservedAt: {},
  } };
}

describe("multi-feed store contract", () => {
  it("lists Raydium as the primary Solana feed and maps each feed to one protocol", () => {
    expect(SOLANA_FEED_KEYS[0]).toBe(FEED_KEY);
    expect(SOLANA_FEED_PROTOCOL).toEqual({ [FEED_KEY]: "raydium-clmm", [FEED_KEY_METEORA]: "meteora-dlmm" });
  });

  it("accepts a discovery row only in its protocol's feed (no feedKey = Raydium, as before)", () => {
    const ok = (value: unknown) => storeRequestSchema.safeParse(value).success;
    expect(ok(discovery(undefined))).toBe(true);
    expect(ok(discovery("raydium-clmm"))).toBe(true);
    expect(ok(discovery("meteora-dlmm"))).toBe(false);
    expect(ok(discovery("meteora-dlmm", FEED_KEY_METEORA))).toBe(true);
    expect(ok(discovery("raydium-clmm", FEED_KEY_METEORA))).toBe(false);
    expect(ok(discovery(undefined, FEED_KEY_METEORA))).toBe(false);
    expect(ok(discovery("raydium-clmm", "uniswap-v4-rhc-v1"))).toBe(false);
  });

  it("reads feeds Raydium first, without duplicates; omitting feedKeys keeps the one-feed read", () => {
    const pairs = (feedKeys?: string[]) => storeRequestSchema.safeParse({ op: "pairs", minTvl: 0, maxPages: 1, sortBy: "tvl",
      ...(feedKeys ? { feedKeys } : {}) });
    expect(pairs().success).toBe(true);
    expect(pairs([FEED_KEY, FEED_KEY_METEORA]).success).toBe(true);
    expect(pairs([FEED_KEY_METEORA, FEED_KEY]).success).toBe(false);
    expect(pairs([FEED_KEY, FEED_KEY]).success).toBe(false);
    expect(pairs([]).success).toBe(false);
    expect(storeRequestSchema.safeParse({ op: "activePools", feedKeys: [FEED_KEY, FEED_KEY_METEORA] }).success).toBe(true);
  });

  it("allows 4 Raydium presets, 3 RHC presets and 1-4 Meteora presets", () => {
    const sol = "1".repeat(32), evm = `0x${"a".repeat(64)}`;
    expect([1, 2, 3, 4, 5].map((n) => presetCountAllowed(sol, undefined, n))).toEqual([false, false, false, true, false]);
    expect([1, 2, 3, 4, 5].map((n) => presetCountAllowed(sol, "raydium-clmm", n))).toEqual([false, false, false, true, false]);
    expect([1, 2, 3, 4, 5].map((n) => presetCountAllowed(sol, "meteora-dlmm", n))).toEqual([true, true, true, true, false]);
    expect([2, 3, 4].map((n) => presetCountAllowed(evm, "uniswap-v4-rhc", n))).toEqual([false, true, false]);
  });
});
