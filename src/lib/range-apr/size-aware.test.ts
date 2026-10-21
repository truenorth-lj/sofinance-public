import { describe, expect, it } from "vitest";
import { degradedPayloadFixture, payloadFixture } from "./payload.fixture";
import {
  activeLiquidity, depositUsd, EDGE_TO_IMPACT_MIN_MULTIPLE, estimatedPoolImpactBps, nearerEdgeBps, payloadForCapital, sizeFitFor,
} from "./size-aware";
import { buildPresetList } from "./preset-list";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { tslaPayload } from "./tsla-payload.fixture";

// Fixture: spacing 1, current sqrt 1 (tick 0), 1e9 liquidity per bin, usdPerRawB 1.
describe("size checks", () => {
  const payload = payloadFixture();

  it("reads the liquidity active at the current price", () => {
    expect(activeLiquidity(payload)).toBe(1e9);
    expect(activeLiquidity(payloadFixture({ pool: { ...payload.pool, tickCurrent: 500 } }))).toBeNull();
  });

  it("estimates impact from half the deposit swapped into the active liquidity", () => {
    // 1e5 USD -> 5e4 raw B -> sqrt +5e-5 -> price +1.0 bp.
    expect(estimatedPoolImpactBps(payload, 1e5)).toBeCloseTo(1.0, 2);
    expect(estimatedPoolImpactBps(payload, 0)).toBe(0);
    expect(estimatedPoolImpactBps(payloadFixture({ model: { ...payload.model, bins: [] } }), 100)).toBe(Number.POSITIVE_INFINITY);
  });

  it("measures the nearer edge in bps and is 0 outside the range", () => {
    expect(nearerEdgeBps(1, { tickLower: -3, tickUpper: 6 })).toBeCloseTo(3, 1);
    expect(nearerEdgeBps(1, { tickLower: 1, tickUpper: 6 })).toBe(0);
  });

  it("keeps a small deposit, flags near-edge before crowded, and flags a crowded wide range", () => {
    expect(sizeFitFor(payload, { tickLower: -2, tickUpper: 2 }, 100).status).toBe("ok");
    const near = sizeFitFor(payload, { tickLower: -2, tickUpper: 2 }, 150_000);
    expect(near).toMatchObject({ status: "excluded", reason: "near-edge" });
    expect(near.impactBps).toBeGreaterThan(near.edgeBps / EDGE_TO_IMPACT_MIN_MULTIPLE);
    const thin = payloadFixture({ model: { ...payload.model, bins: payload.model.bins.map((bin) => ({ ...bin, liquidity: 1e3 })) } });
    // Tiny pool liquidity: own share dominates even where the edge has room.
    expect(sizeFitFor(thin, { tickLower: -9, tickUpper: 9 }, 1)).toMatchObject({ status: "excluded", reason: "crowded" });
    expect(sizeFitFor(thin, { tickLower: -9, tickUpper: 9 }, 1).ownSharePct).toBeGreaterThan(50);
  });
});

describe("edge vs impact margin", () => {
  const payload = payloadFixture();
  // ~1.2 bp of impact; a +/-3 tick range has its nearer edge ~3 bp away (2.5x): enough under the old 2x guard,
  // not under 3x. Regression for TSLA/TSLAx at 1000 USDC (edge 2.0x impact) where prepare did not converge.
  it("requires the nearer edge to be at least 3x the estimated impact", () => {
    expect(EDGE_TO_IMPACT_MIN_MULTIPLE).toBe(3);
    const fit = sizeFitFor(payload, { tickLower: -3, tickUpper: 3 }, 120_000);
    expect(fit.edgeBps / fit.impactBps).toBeGreaterThan(2);
    expect(fit.edgeBps / fit.impactBps).toBeLessThan(3);
    expect(fit).toMatchObject({ status: "excluded", reason: "near-edge" });
    expect(sizeFitFor(payload, { tickLower: -4, tickUpper: 4 }, 120_000).status).toBe("ok");
  });
});

describe("Best on TSLA/TSLAx (live payload, 2026-10-21)", () => {
  // Prepare results on prod that day: 100 USDC tight/standard/wide and 300 USDC all ranges prepared;
  // 1000 USDC only Wide prepared (Tight and Standard: "did not converge").
  const bestAt = (capitalUsd: number) => buildPresetList(OPEN_RANGE_UI_PRESETS, payloadForCapital(tslaPayload, capitalUsd)).best;
  it("picks Tight at 100 USDC, Standard at 300 and Wide at 1000", () => {
    expect(bestAt(100)?.id).toBe("tight");
    expect(bestAt(300)?.id).toBe("standard");
    expect(bestAt(1000)?.id).toBe("wide");
    expect(bestAt(1000)?.fallback).toBeUndefined();
  });
  it("excludes Standard at 1000 USDC (edge ~2.0x the impact)", () => {
    const standard = payloadForCapital(tslaPayload, 1000).presets.find((preset) => preset.id === "standard")!;
    expect(standard.sizeFit).toMatchObject({ status: "excluded", reason: "near-edge" });
    expect(standard.sizeFit!.edgeBps / standard.sizeFit!.impactBps).toBeGreaterThan(2);
  });
});

describe("payloadForCapital", () => {
  it("returns the served payload unchanged without a usable amount or for degraded data", () => {
    const payload = payloadFixture();
    expect(payloadForCapital(payload, null)).toBe(payload);
    expect(payloadForCapital(payload, 0)).toBe(payload);
    expect(payloadForCapital(payload, Number.NaN)).toBe(payload);
    const degraded = degradedPayloadFixture();
    expect(payloadForCapital(degraded, 1000)).toBe(degraded);
  });

  it("re-prices every candidate at the deposit and attaches its size fit", () => {
    const payload = payloadFixture();
    const sized = payloadForCapital(payload, 50_000);
    expect(sized.referenceCapitalUsd).toBe(50_000);
    for (const [index, preset] of sized.presets.entries()) {
      const before = payload.presets[index]!.estimate;
      expect(preset.sizeFit).toBeDefined();
      if (preset.estimate.status === "ok" && before.status === "ok") {
        // Own liquidity dilutes the fee share, so the rate drops as the deposit grows.
        expect(preset.estimate.aprPct).toBeLessThan(before.aprPct);
      }
    }
  });
});

describe("depositUsd", () => {
  const base = { usdcMint: "USDC", wsolMint: "WSOL", solUsd: 150, mintA: "A", mintB: "B", payload: payloadFixture() };
  it("values USDC 1:1, SOL at the reference rate, and pool tokens from the model", () => {
    expect(depositUsd({ ...base, amount: 1000, inputMint: "USDC", inputKind: "token" })).toBe(1000);
    expect(depositUsd({ ...base, amount: 2, inputMint: "WSOL", inputKind: "native" })).toBe(300);
    expect(depositUsd({ ...base, amount: 2, inputMint: "B", inputKind: "token" })).toBe(2e6);
    expect(depositUsd({ ...base, amount: 2, inputMint: "A", inputKind: "token" })).toBe(2e6);
  });
  it("returns null when the amount or asset cannot be valued", () => {
    expect(depositUsd({ ...base, amount: null, inputMint: "USDC", inputKind: "token" })).toBeNull();
    expect(depositUsd({ ...base, amount: 0, inputMint: "USDC", inputKind: "token" })).toBeNull();
    expect(depositUsd({ ...base, solUsd: null, amount: 1, inputMint: "WSOL", inputKind: "native" })).toBeNull();
    expect(depositUsd({ ...base, amount: 1, inputMint: "OTHER", inputKind: "token" })).toBeNull();
    expect(depositUsd({ ...base, payload: null, amount: 1, inputMint: "B", inputKind: "token" })).toBeNull();
  });
});
