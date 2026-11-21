import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { priceSingleAssets } from "./single-asset";

const mint = () => Keypair.generate().publicKey.toBase58();
const nowMs = Date.parse("2026-11-21T09:00:00Z");

describe("priceSingleAssets", () => {
  it("uses Jupiter's scaledUiConfig when no mint account was read", () => {
    const m = mint();
    const priced = priceSingleAssets({ nowMs, quotesObservedAtMs: nowMs, assets: [{ mint: m, decimals: 6, account: null,
      quote: { price: 50, source: "jupiter", basis: "per-share", scaledUiConfig: { multiplier: 2, newMultiplier: 2 } } }] });
    expect(priced.get(m)).toEqual({ usdPerRawUnit: 100, multiplier: 2 });
  });
  it("is unknown (null, never 1) without any multiplier fact, and unpriced without a quote", () => {
    const a = mint(), b = mint();
    const priced = priceSingleAssets({ nowMs, quotesObservedAtMs: nowMs, assets: [
      { mint: a, decimals: 6, account: null, quote: { price: 50, source: "jupiter", basis: "per-share" } },
      { mint: b, decimals: 6, account: null, quote: undefined },
    ] });
    expect(priced.get(a)).toEqual({ usdPerRawUnit: null, multiplier: null });
    expect(priced.get(b)?.usdPerRawUnit).toBeNull();
  });
  it("evaluates a scheduled multiplier at nowMs", () => {
    const m = mint();
    const warn = vi.fn();
    const config = { multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: nowMs / 1000 - 60 };
    const priced = priceSingleAssets({ nowMs, quotesObservedAtMs: nowMs, warn, assets: [{ mint: m, decimals: 6, account: undefined,
      quote: { price: 25, source: "jupiter", basis: "per-share", scaledUiConfig: config } }] });
    expect(priced.get(m)).toEqual({ usdPerRawUnit: 100, multiplier: 4 });
    expect(warn).not.toHaveBeenCalled();
  });
});
