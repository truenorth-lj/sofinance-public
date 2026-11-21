import { describe, expect, it } from "vitest";
import { effectiveScaledUiMultiplier, multiplierAt } from "./multiplier";
import { valueOf } from "./value";
import type { MultiplierReading } from "./types";

const SNDKX_SWITCH_SECONDS = 1_795_167_000;
const sndkx: MultiplierReading = {
  kind: "scaled-ui",
  config: { multiplier: 1, newMultiplier: 8, newMultiplierEffectiveTimestamp: SNDKX_SWITCH_SECONDS },
};

describe("valuation multiplier", () => {
  it("evaluates a stored scaled-ui config at read time", () => {
    expect(multiplierAt(sndkx, SNDKX_SWITCH_SECONDS * 1000 - 1)).toBe(1);
    expect(multiplierAt(sndkx, SNDKX_SWITCH_SECONDS * 1000)).toBe(8);
  });

  it("keeps known-no-multiplier separate from unknown", () => {
    expect(multiplierAt({ kind: "none" }, 0)).toBe(1);
    expect(multiplierAt({ kind: "unknown" }, 0)).toBeNull();
  });

  it("accepts millisecond timestamps and rejects invalid effective values", () => {
    expect(effectiveScaledUiMultiplier({ multiplier: 1, newMultiplier: 2, newMultiplierEffectiveTimestamp: SNDKX_SWITCH_SECONDS * 1000 }, SNDKX_SWITCH_SECONDS * 1000)).toBe(2);
    expect(multiplierAt({ kind: "scaled-ui", config: { multiplier: 0, newMultiplier: 0 } }, 0)).toBeNull();
  });
});

describe("valueOf", () => {
  it("applies the multiplier only to per-share quotes", () => {
    const perShare = valueOf({ raw: 1_000_000n, decimals: 6, multiplier: { kind: "scaled-ui", config: { multiplier: 8, newMultiplier: 8 } }, quote: { basis: "per-share", usd: 78.63 }, nowMs: 0 });
    const perRaw = valueOf({ raw: 1_000_000n, decimals: 6, multiplier: { kind: "scaled-ui", config: { multiplier: 8, newMultiplier: 8 } }, quote: { basis: "per-raw-unit", usd: 630.67 }, nowMs: 0 });
    expect(perShare).toMatchObject({ kind: "valued", usdPerRawUnit: 629.04 });
    expect(perShare.kind === "valued" ? perShare.usd : NaN).toBeCloseTo(629.04, 10);
    expect(perRaw).toMatchObject({ kind: "valued", usdPerRawUnit: 630.67, usd: 630.67 });
  });

  it("matches the equivalent per-raw quote", () => {
    for (const [raw, decimals, multiplier, usd] of [[1n, 0, 1, 1], [123_456_789n, 8, 1.001701196801074, 127.3999], [5_660_700n, 6, 8.00000022993473, 78.6347]] as const) {
      const reading: MultiplierReading = { kind: "scaled-ui", config: { multiplier, newMultiplier: multiplier } };
      const share = valueOf({ raw, decimals, multiplier: reading, quote: { basis: "per-share", usd }, nowMs: 0 });
      const rawQuote = valueOf({ raw, decimals, multiplier: { kind: "none" }, quote: { basis: "per-raw-unit", usd: usd * multiplier }, nowMs: 0 });
      expect(share.kind).toBe("valued");
      expect(rawQuote.kind).toBe("valued");
      if (share.kind === "valued" && rawQuote.kind === "valued") expect(share.usd).toBeCloseTo(rawQuote.usd, 9);
    }
  });

  it("preserves equivalent bases over deterministic generated inputs", () => {
    let seed = 481;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 200; i++) {
      const raw = BigInt(Math.floor(next() * 1e15));
      const decimals = Math.floor(next() * 19);
      const multiplier = 0.1 + next() * 10;
      const usd = 0.01 + next() * 1000;
      const common = { raw, decimals, nowMs: 0 };
      const share = valueOf({ ...common, multiplier: { kind: "scaled-ui", config: { multiplier, newMultiplier: multiplier } }, quote: { basis: "per-share", usd } });
      const rawQuote = valueOf({ ...common, multiplier: { kind: "none" }, quote: { basis: "per-raw-unit", usd: usd * multiplier } });
      expect(share.kind).toBe("valued");
      expect(rawQuote.kind).toBe("valued");
      if (share.kind === "valued" && rawQuote.kind === "valued") expect(share.usd / rawQuote.usd).toBeCloseTo(1, 12);
    }
  });

  it("round-trips configs and results through JSON without losing the schedule", () => {
    const reading = JSON.parse(JSON.stringify(sndkx));
    const result = valueOf({ raw: 100_000_000n, decimals: 8, multiplier: reading, quote: { basis: "per-share", usd: 80 }, nowMs: SNDKX_SWITCH_SECONDS * 1000 });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ kind: "valued", usd: 640, usdPerRawUnit: 640 });
  });

  it("allows per-raw quotes without a multiplier and values zero balances", () => {
    expect(valueOf({ raw: 0n, decimals: 6, multiplier: { kind: "unknown" }, quote: { basis: "per-raw-unit", usd: 2 }, nowMs: 0 })).toEqual({ kind: "valued", usd: 0, usdPerRawUnit: 2 });
  });

  it("returns unpriced for an unknown multiplier or invalid input", () => {
    expect(valueOf({ raw: 1n, decimals: 0, multiplier: { kind: "unknown" }, quote: { basis: "per-share", usd: 1 }, nowMs: 0 })).toEqual({ kind: "unpriced", reason: "multiplier-unknown" });
    for (const usd of [0, -1, NaN, Infinity]) expect(valueOf({ raw: 1n, decimals: 6, multiplier: { kind: "none" }, quote: { basis: "per-share", usd }, nowMs: 0 }).kind).toBe("unpriced");
    expect(valueOf({ raw: -1n, decimals: 0, multiplier: { kind: "none" }, quote: { basis: "per-share", usd: 1 }, nowMs: 0 })).toEqual({ kind: "unpriced", reason: "invalid-input" });
    expect(valueOf({ raw: 1n, decimals: 0.5, multiplier: { kind: "none" }, quote: { basis: "per-share", usd: 1 }, nowMs: 0 })).toEqual({ kind: "unpriced", reason: "invalid-input" });
  });
});
