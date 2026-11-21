import { MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import capture from "../../packages/engine/src/fixtures/multiplier-pools-2026-11-21.json";
import { assetKey } from "@sofinance/engine/valuation/asset";
import { mintAccountHint } from "@sofinance/engine/valuation/multiplier-sources/token2022-scaled-ui";
import { assetRegistry } from "@sofinance/engine/valuation/registry";
import type { TokenPriceQuote } from "@sofinance/engine/token-prices";

vi.mock("server-only", () => ({}));
const { pricePosition } = await import("./position-performance-assemble");

/**
 * GATE (X3-3): every pool whose tokens carry a share multiplier (9 Solana + 2 Robinhood Chain, captured 2026-11-21)
 * plus ordinary pools. Each Solana mint account is re-encoded from the capture and goes through the same path as
 * production: `mintAccountHint` on the reader's batched account, then the registry. No asset may come out unknown.
 */
const NOW_MS = Date.parse(capture.capturedAt);
type Side = (typeof capture.solana)[number]["a"];

function mintAccount(side: { owner: string; decimals: number; scaledUiAmountConfig: Side["scaledUiAmountConfig"] | null }): AccountInfo<Buffer> {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000n, decimals: side.decimals,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, base);
  const owner = new PublicKey(side.owner);
  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) return { owner, data: base, executable: false, lamports: 1, rentEpoch: 0 };
  // Token-2022: base layout, padding to 165, account type (1 = mint), then the ScaledUiAmountConfig TLV when present.
  const config = side.scaledUiAmountConfig;
  const data = Buffer.alloc(166 + (config ? 4 + 56 : 0));
  base.copy(data);
  data.writeUInt8(1, 165);
  if (config) {
    data.writeUInt16LE(ExtensionType.ScaledUiAmountConfig, 166);
    data.writeUInt16LE(56, 168);
    data.writeDoubleLE(config.multiplier, 170 + 32);
    data.writeBigInt64LE(BigInt(config.newMultiplierEffectiveTimestamp), 170 + 40);
    data.writeDoubleLE(config.newMultiplier, 170 + 48);
  }
  return { owner, data, executable: false, lamports: 1, rentEpoch: 0 };
}

const jupiterQuote = (side: Side): TokenPriceQuote => {
  const row = side.jupiter!;
  return { price: row.usdPrice, source: "jupiter", basis: "per-share", liquidityUsd: row.liquidity,
    ...(row.scaledUiConfig ? { scaledUiConfig: { multiplier: row.scaledUiConfig.multiplier, newMultiplier: row.scaledUiConfig.newMultiplier,
      newMultiplierEffectiveTimestamp: Date.parse(row.scaledUiConfig.newMultiplierEffectiveAt) / 1000 } } : {}) };
};

const pricingSide = (side: Side) => ({ mint: side.mint, decimals: side.decimals, hint: mintAccountHint(side.mint, mintAccount(side)) });

const priced = (pool: (typeof capture.solana)[number]) => pricePosition({
  a: pricingSide(pool.a), b: pricingSide(pool.b), quoteA: jupiterQuote(pool.a), quoteB: jupiterQuote(pool.b),
  poolPriceBPerA: pool.poolRawPriceBPerA, nowMs: NOW_MS, quotesObservedAtMs: NOW_MS,
});

const onChainMultiplier = (side: Side) => {
  const config = side.scaledUiAmountConfig!;
  return NOW_MS >= config.newMultiplierEffectiveTimestamp * 1000 ? config.newMultiplier : config.multiplier;
};

describe("GATE: the 9 Solana multiplier pools through the production hint path", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  it("covers exactly the captured pools", () => {
    expect(capture.solana.map((pool) => pool.pool)).toEqual(["SPY/SPYx", "AVGOx/AVGO", "SNDK/SNDKx", "NVDA/NVDAx", "NVDA/NVDAx",
      "AAPLx/AAPL", "META/METAx", "SKHY/SKHYx", "GOOGLx/GOOGL"]);
  });

  it.each(capture.solana.map((pool) => [`${pool.pool} (${pool.protocol})`, pool] as const))("%s: both assets known, USD per raw = share price × on-chain multiplier", (_name, pool) => {
    for (const side of [pool.a, pool.b]) {
      const hint = mintAccountHint(side.mint, mintAccount(side));
      expect(hint?.kind).toBe("mint-extensions");
      const asset = assetRegistry.resolve([{ ref: { chain: "solana", address: side.mint }, decimals: side.decimals, hints: hint ? [hint] : [] }], { nowMs: NOW_MS })
        .get(assetKey({ chain: "solana", address: side.mint }))!;
      expect(asset.facts.multiplier.kind).not.toBe("unknown");
      expect(asset.multiplierAt(NOW_MS)).toBe(onChainMultiplier(side));
    }
    const pricing = priced(pool);
    expect(pricing.multiplierA).toBe(onChainMultiplier(pool.a));
    expect(pricing.multiplierB).toBe(onChainMultiplier(pool.b));
    expect(pricing.basis).toEqual({ a: "per-share", b: "per-share" });
    const guard = pricing.guard!;
    if (guard.kind === "corrected") {
      // The suspect side is replaced by the pool-implied price; the other keeps share price × multiplier.
      const kept = guard.side === "a" ? "b" : "a";
      expect(pricing[`usdPerRawUnit${kept.toUpperCase() as "A" | "B"}`]).toBeCloseTo(pool[kept].jupiter!.usdPrice * onChainMultiplier(pool[kept]), 9);
      expect(guard.ownUsdPerRawUnit).toBeCloseTo(pool[guard.side].jupiter!.usdPrice * onChainMultiplier(pool[guard.side]), 9);
    } else {
      expect(guard.kind).toBe("agreed");
      expect(pricing.usdPerRawUnitA).toBeCloseTo(pool.a.jupiter!.usdPrice * onChainMultiplier(pool.a), 9);
      expect(pricing.usdPerRawUnitB).toBeCloseTo(pool.b.jupiter!.usdPrice * onChainMultiplier(pool.b), 9);
    }
    // After the guard the two USD prices agree with the pool within 2%: pA ≈ r × pB.
    expect(Math.abs(pricing.usdPerRawUnitA! / (pool.poolRawPriceBPerA * pricing.usdPerRawUnitB!) - 1)).toBeLessThanOrEqual(0.02);
  });

  it("the pair guard: SNDK (2.87%, both ×8, lower liquidity side) and SKHY (8.78%, only SKHYx scaled) are corrected; the rest agree", () => {
    const guards = Object.fromEntries(capture.solana.map((pool) => [`${pool.pool} ${pool.protocol}`, priced(pool).guard]));
    expect(guards["SNDK/SNDKx raydium-clmm"]).toMatchObject({ kind: "corrected", rule: "liquidity", relativeDiff: expect.closeTo(0.02869, 4) });
    expect(guards["SKHY/SKHYx raydium-clmm"]).toMatchObject({ kind: "corrected", rule: "multiplier", side: "b", relativeDiff: expect.closeTo(0.0878, 3) });
    const others = Object.entries(guards).filter(([name]) => !name.startsWith("SNDK") && !name.startsWith("SKHY"));
    expect(others).toHaveLength(7);
    for (const [, guard] of others) expect(guard).toMatchObject({ kind: "agreed" });
  });

  it("SNDK/SNDKx: USD per raw is about 8× the share price on both sides, never the share price itself", () => {
    const pool = capture.solana.find((row) => row.pool === "SNDK/SNDKx")!;
    const pricing = priced(pool);
    expect(pricing.usdPerRawUnitA! / pool.a.jupiter!.usdPrice).toBeGreaterThan(7.5);
    expect(pricing.usdPerRawUnitB! / pool.b.jupiter!.usdPrice).toBeGreaterThan(7.5);
    expect(pricing.sharePriceUsdA! * pricing.multiplierA!).toBeCloseTo(pricing.usdPerRawUnitA!, 9);
  });
});

describe("GATE: the 2 Robinhood Chain multiplier pools", () => {
  it.each(capture.robinhood.map((pool) => [pool.pool, pool] as const))("%s: both assets known as 1; the stored GT price is used as is (per raw)", (_name, pool) => {
    for (const side of [pool.a, pool.b]) {
      const ref = { chain: "robinhood" as const, address: side.address };
      const asset = assetRegistry.resolve([{ ref, decimals: 18 }], { nowMs: NOW_MS }).get(assetKey(ref))!;
      expect(asset.facts).toMatchObject({ multiplier: { kind: "none" }, multiplierSource: "rhc-per-raw" });
      expect(asset.usdPerRawUnit(assetRegistry.rhcStoredQuote(side.gtUsdPerRawUnit)!, NOW_MS)).toBe(side.gtUsdPerRawUnit);
    }
  });
});

describe("GATE: ordinary pools", () => {
  const USDC = { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, scaledUiAmountConfig: null };
  const SOL = { mint: "So11111111111111111111111111111111111111112", owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 9, scaledUiAmountConfig: null };
  const PYUSD = { mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", owner: TOKEN_2022_PROGRAM_ID.toBase58(), decimals: 6, scaledUiAmountConfig: null };
  const side = (token: { mint: string; owner: string; decimals: number; scaledUiAmountConfig: null }) => ({ mint: token.mint, decimals: token.decimals, hint: mintAccountHint(token.mint, mintAccount(token)) });

  it.each([["SOL/USDC (SPL + SPL)", SOL, USDC, 140, 1, 140], ["PYUSD/USDC (Token-2022 without the extension + SPL)", PYUSD, USDC, 1, 1, 1]] as const)(
    "%s: known as 1, USD per raw equals the quote", (_name, a, b, usdA, usdB, poolPrice) => {
      const pricing = pricePosition({ a: side(a), b: side(b),
        quoteA: { price: usdA, source: "jupiter", basis: "per-share" }, quoteB: { price: usdB, source: "jupiter", basis: "per-share" },
        poolPriceBPerA: poolPrice, nowMs: NOW_MS, quotesObservedAtMs: NOW_MS });
      expect(pricing).toMatchObject({ usdPerRawUnitA: usdA, usdPerRawUnitB: usdB, multiplierA: 1, multiplierB: 1, guard: { kind: "not-checked", reason: "no-multiplier" } });
    });

  it.each([["SOL/USDC", SOL, USDC], ["PYUSD/USDC", PYUSD, USDC]] as const)(
    "%s: even wildly disagreeing quotes are never guard-corrected", (_name, a, b) => {
      const pricing = pricePosition({ a: side(a), b: side(b),
        quoteA: { price: 20, source: "jupiter", basis: "per-share", liquidityUsd: 1 },
        quoteB: { price: 1, source: "jupiter", basis: "per-share", liquidityUsd: 1_000_000 },
        poolPriceBPerA: 100, nowMs: NOW_MS, quotesObservedAtMs: NOW_MS });
      expect(pricing).toMatchObject({ usdPerRawUnitA: 20, usdPerRawUnitB: 1,
        guard: { kind: "not-checked", reason: "no-multiplier" } });
    });

  it("a DexScreener / Raydium per-raw quote is never multiplied again", () => {
    const pool = capture.solana.find((row) => row.pool === "SNDK/SNDKx")!;
    const pricing = pricePosition({ a: pricingSide(pool.a), b: pricingSide(pool.b),
      quoteA: { price: 630.67, source: "dexscreener", basis: "per-raw-unit" }, quoteB: { price: 630.9, source: "raydium", basis: "per-raw-unit" },
      poolPriceBPerA: pool.poolRawPriceBPerA, nowMs: NOW_MS, quotesObservedAtMs: NOW_MS });
    expect(pricing).toMatchObject({ usdPerRawUnitA: 630.67, usdPerRawUnitB: 630.9, basis: { a: "per-raw-unit", b: "per-raw-unit" } });
  });
});
