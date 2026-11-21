import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createAsset } from "./asset";
import { mintAccountHint } from "./multiplier-sources/token2022-scaled-ui";
import { PAIR_GUARD_MAX_RELATIVE_DIFF, pricePair, sqrtPriceX64ToPriceBPerA } from "./pair-pricing";
import type { AssetFacts, PriceQuote } from "./types";

const NOW = Date.parse("2026-11-21T08:00:00Z");
const asset = (multiplier: number | null) => createAsset({
  ref: { chain: "solana", address: Keypair.generate().publicKey.toBase58() }, decimals: 6,
  multiplier: multiplier === null ? { kind: "unknown" } : multiplier === 1 ? { kind: "none" }
    : { kind: "scaled-ui", config: { multiplier, newMultiplier: multiplier, newMultiplierEffectiveTimestamp: 0 } },
  multiplierSource: multiplier === null ? null : "token2022-scaled-ui",
} satisfies AssetFacts);
const share = (usd: number, liquidityUsd?: number): PriceQuote => ({ basis: "per-share", usd, source: "jupiter", ...(liquidityUsd !== undefined ? { liquidityUsd } : {}) });

describe("pricePair", () => {
  it("applies the multiplier to per-share quotes only and keeps prices that agree with the pool", () => {
    const priced = pricePair({ a: { asset: asset(8), quote: share(80) }, b: { asset: asset(1), quote: { basis: "per-raw-unit", usd: 640, source: "dexscreener" } },
      poolPriceBPerA: 1, nowMs: NOW });
    expect(priced).toEqual({
      a: { usdPerRawUnit: 640, sharePriceUsd: 80, multiplier: 8, basis: "per-share" },
      b: { usdPerRawUnit: 640, sharePriceUsd: 640, multiplier: 1, basis: "per-raw-unit" },
      guard: { kind: "agreed", relativeDiff: 0 },
    });
  });

  it("exactly at the 2% gate still agrees; just above is corrected", () => {
    expect(PAIR_GUARD_MAX_RELATIVE_DIFF).toBe(0.02);
    const at = pricePair({ a: { asset: asset(1), quote: share(102) }, b: { asset: asset(1), quote: share(100, 5) }, poolPriceBPerA: 1, nowMs: NOW });
    expect(at.guard.kind).toBe("agreed");
    const over = pricePair({ a: { asset: asset(1), quote: share(102.5, 1) }, b: { asset: asset(1), quote: share(100, 5) }, poolPriceBPerA: 1, nowMs: NOW });
    expect(over.guard).toMatchObject({ kind: "corrected", side: "a", rule: "liquidity", ownUsdPerRawUnit: 102.5 });
    expect(over.a.usdPerRawUnit).toBe(100);
  });

  it("only one side scaled: that side is suspect and takes the price implied by the other side and the pool", () => {
    const priced = pricePair({ a: { asset: asset(1), quote: share(103, 1) }, b: { asset: asset(1.0001), quote: share(96, 1_000_000) }, poolPriceBPerA: 1.01, nowMs: NOW });
    expect(priced.guard).toMatchObject({ kind: "corrected", side: "b", rule: "multiplier" });
    expect(priced.b.usdPerRawUnit).toBeCloseTo(103 / 1.01, 12);
    expect(priced.b.sharePriceUsd).toBeCloseTo(103 / 1.01 / 1.0001, 12);
    expect(priced.a.usdPerRawUnit).toBe(103);
  });

  it("both scaled: the side with less liquidity is suspect (a missing liquidity counts as none)", () => {
    const priced = pricePair({ a: { asset: asset(8), quote: share(78.6) }, b: { asset: asset(8), quote: share(81, 50_000) }, poolPriceBPerA: 0.9996, nowMs: NOW });
    expect(priced.guard).toMatchObject({ kind: "corrected", side: "a", rule: "liquidity" });
    expect(priced.a.usdPerRawUnit).toBeCloseTo(0.9996 * 81 * 8, 9);
  });

  it("over the gate with no way to pick a side keeps both prices and says so", () => {
    const priced = pricePair({ a: { asset: asset(1), quote: share(110) }, b: { asset: asset(1), quote: share(100) }, poolPriceBPerA: 1, nowMs: NOW });
    expect(priced.guard).toEqual({ kind: "unresolved", relativeDiff: expect.closeTo(0.1, 12) });
    expect([priced.a.usdPerRawUnit, priced.b.usdPerRawUnit]).toEqual([110, 100]);
  });

  it("does not check without both prices or without a pool price; an unknown multiplier is unpriced", () => {
    expect(pricePair({ a: { asset: asset(null), quote: share(1) }, b: { asset: asset(1), quote: share(1) }, poolPriceBPerA: 1, nowMs: NOW }))
      .toMatchObject({ a: { usdPerRawUnit: null, multiplier: null, sharePriceUsd: null }, guard: { kind: "not-checked", reason: "missing-price" } });
    expect(pricePair({ a: { asset: asset(1), quote: null }, b: { asset: asset(1), quote: share(1) }, poolPriceBPerA: 1, nowMs: NOW }).guard)
      .toEqual({ kind: "not-checked", reason: "missing-price" });
    for (const poolPriceBPerA of [null, 0, Number.NaN]) {
      expect(pricePair({ a: { asset: asset(1), quote: share(1) }, b: { asset: asset(1), quote: share(2) }, poolPriceBPerA, nowMs: NOW }).guard)
        .toEqual({ kind: "not-checked", reason: "no-pool-price" });
    }
  });

  it("the result is plain data", () => {
    const priced = pricePair({ a: { asset: asset(8), quote: share(80) }, b: { asset: asset(1), quote: share(640) }, poolPriceBPerA: 1, nowMs: NOW });
    expect(JSON.parse(JSON.stringify(priced))).toEqual(priced);
  });
});

describe("sqrtPriceX64ToPriceBPerA", () => {
  it("is (sqrt / 2^64)^2 with decimals applied", () => {
    expect(sqrtPriceX64ToPriceBPerA((1n << 64n).toString(), 6, 6)).toBe(1);
    expect(sqrtPriceX64ToPriceBPerA(2n << 64n, 8, 6)).toBe(400);
  });
});

describe("mintAccountHint", () => {
  const owned = (owner = TOKEN_PROGRAM_ID, data = Buffer.alloc(82)): AccountInfo<Buffer> => ({ owner, data, executable: false, lamports: 1, rentEpoch: 0 });
  const mint = Keypair.generate().publicKey.toBase58();
  it("is null (asset stays unknown) for a missing account, a non-token owner, or data that does not decode", () => {
    expect(mintAccountHint(mint, null)).toBeNull();
    expect(mintAccountHint(mint, undefined)).toBeNull();
    expect(mintAccountHint(mint, owned(Keypair.generate().publicKey))).toBeNull();
    expect(mintAccountHint(mint, owned(TOKEN_PROGRAM_ID, Buffer.alloc(10)))).toBeNull();
  });
});
