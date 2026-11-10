import { describe, expect, it } from "vitest";
import { degradedPayloadFixture, payloadFixture } from "./payload.fixture";
import { depositUsd, payloadForCapital } from "./size-aware";
import { buildPresetList } from "./preset-list";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { tslaPayload } from "./tsla-payload.fixture";

describe("payloadForCapital", () => {
  it("returns the served payload unchanged without a usable amount or for degraded data", () => {
    const payload = payloadFixture();
    expect(payloadForCapital(payload, null)).toBe(payload);
    expect(payloadForCapital(payload, 0)).toBe(payload);
    expect(payloadForCapital(payload, Number.NaN)).toBe(payload);
    const degraded = degradedPayloadFixture();
    expect(payloadForCapital(degraded, 1000)).toBe(degraded);
  });

  it("re-prices every candidate at the deposit and does not attach a size fit", () => {
    const payload = payloadFixture();
    const sized = payloadForCapital(payload, 50_000);
    expect(sized.referenceCapitalUsd).toBe(50_000);
    for (const [index, preset] of sized.presets.entries()) {
      const before = payload.presets[index]!.estimate;
      expect(preset).not.toHaveProperty("sizeFit");
      if (preset.estimate.status === "ok" && before.status === "ok") {
        // Own liquidity dilutes the fee share, so the rate drops as the deposit grows.
        expect(preset.estimate.aprPct).toBeLessThan(before.aprPct);
      }
    }
  });

  it("still ranks a Best on TSLA/TSLAx at 100, 300 and 1,000 USDC", () => {
    const bestAt = (capitalUsd: number) => buildPresetList(OPEN_RANGE_UI_PRESETS, payloadForCapital(tslaPayload, capitalUsd)).best;
    expect(bestAt(100)?.id).toBeTruthy();
    expect(bestAt(300)?.id).toBeTruthy();
    expect(bestAt(1000)?.id).toBeTruthy();
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
