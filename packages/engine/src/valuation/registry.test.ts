import { describe, expect, it } from "vitest";
import priceV3Capture from "../fixtures/jupiter-price-v3-sndk-nvdax.json";
import type { TokenPriceQuote } from "../token-prices";
import { assetKey, createAsset } from "./asset";
import { scaledUiConfigFromExtension } from "./multiplier-sources/token2022-scaled-ui";
import { multiplierHintsFromQuote } from "./price-sources/token-price-quotes";
import { assetRegistry } from "./registry";
import type { AssetRef, MultiplierHint, ScaledUiMultiplierConfig, ValuationWarning } from "./types";

type ConfigHint = Extract<MultiplierHint, { kind: "scaled-ui-config" }>;

const { response, capturedAt } = priceV3Capture;
const CAPTURED_MS = Date.parse(capturedAt);
const CTX = { nowMs: CAPTURED_MS };
const SNDK: AssetRef = { chain: "solana", address: "SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH" };
const SNDKX: AssetRef = { chain: "solana", address: "Xswbpc8UqU6e1j9QZEWCjBMjyvz4twqD7PCy6j2e7jj" };
const NVDAX: AssetRef = { chain: "solana", address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" };
const USDC: AssetRef = { chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const RHC_TOKEN: AssetRef = { chain: "robinhood", address: "0x00000000000000000000000000000000000000aa" };

type CapturedRow = (typeof response)[keyof typeof response];
const rows: Record<string, CapturedRow> = response;
const configOf = (row: CapturedRow): ScaledUiMultiplierConfig => ({
  multiplier: row.scaledUiConfig.multiplier,
  newMultiplier: row.scaledUiConfig.newMultiplier,
  newMultiplierEffectiveTimestamp: Date.parse(row.scaledUiConfig.newMultiplierEffectiveAt) / 1000,
});
const jupiterQuote = (row: CapturedRow): TokenPriceQuote =>
  ({ price: row.usdPrice, source: "jupiter", basis: "per-share", scaledUiConfig: configOf(row), liquidityUsd: row.liquidity });

describe("asset registry on a real Jupiter Price v3 response", () => {
  it.each([["SNDK", SNDK], ["SNDKx", SNDKX], ["NVDAx", NVDAX]] as const)(
    "%s: per-share usdPrice × effective multiplier equals Jupiter's own usdPricePrescaled", (_name, ref) => {
      const row = rows[ref.address]!;
      const quote = jupiterQuote(row);
      const asset = assetRegistry.resolve([{ ref, decimals: row.decimals, hints: multiplierHintsFromQuote(quote, CAPTURED_MS) }], CTX).get(assetKey(ref))!;
      expect(asset.facts.multiplierSource).toBe("token2022-scaled-ui");
      const priced = assetRegistry.quoteOf(quote)!;
      expect(priced).toEqual({ basis: "per-share", usd: row.usdPrice, source: "jupiter", liquidityUsd: row.liquidity });
      expect(asset.usdPerRawUnit(priced, CAPTURED_MS)).toBeCloseTo(row.scaledUiConfig.usdPricePrescaled, 6);
      const oneToken = 10n ** BigInt(row.decimals);
      expect(asset.value(oneToken, priced, CAPTURED_MS)).toMatchObject({ kind: "valued", usd: expect.closeTo(row.scaledUiConfig.usdPricePrescaled, 6) });
    });

  it("SNDKx before its 1 → 8 switch is valued at multiplier 1", () => {
    const row = rows[SNDKX.address]!;
    const asset = assetRegistry.resolve([{ ref: SNDKX, decimals: 8, hints: multiplierHintsFromQuote(jupiterQuote(row), CAPTURED_MS) }], CTX).get(assetKey(SNDKX))!;
    expect(asset.multiplierAt(Date.parse("2026-11-20T09:29:59Z"))).toBe(1);
    expect(asset.multiplierAt(Date.parse("2026-11-20T09:30:00Z"))).toBe(8);
  });
});

describe("multiplier source priority", () => {
  // A snapshot from before the issuer scheduled SNDKx's 1 → 8 switch, and Jupiter's newer response that has it.
  const snapshot: MultiplierHint = { kind: "scaled-ui-config", origin: "snapshot", observedAtMs: CAPTURED_MS - 86_400_000, config: { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTimestamp: null } };
  const jupiter: MultiplierHint = { kind: "scaled-ui-config", origin: "jupiter", observedAtMs: CAPTURED_MS, config: { multiplier: 1, newMultiplier: 8, newMultiplierEffectiveTimestamp: 1_795_167_000 } };
  const resolveOne = (ref: AssetRef, hints: MultiplierHint[]) => assetRegistry.resolve([{ ref, decimals: 6, hints }], CTX).get(assetKey(ref))!.facts;

  it("an on-chain mint read wins over the snapshot and Jupiter", () => {
    const onchain: MultiplierHint = { kind: "mint-extensions", scaledUiConfig: { multiplier: 2, newMultiplier: 2, newMultiplierEffectiveTimestamp: 0 } };
    expect(resolveOne(SNDKX, [jupiter, snapshot, onchain])).toMatchObject({ multiplierSource: "token2022-scaled-ui", multiplier: { kind: "scaled-ui", config: { multiplier: 2 } } });
  });

  it("a mint read with no extension is known to be 1, even if a stored config says otherwise", () => {
    expect(resolveOne(USDC, [snapshot, { kind: "mint-extensions", scaledUiConfig: null }])).toEqual({ ref: USDC, decimals: 6, multiplier: { kind: "none" }, multiplierSource: "spl-plain" });
  });

  it("a stale snapshot never overrides a newer Jupiter schedule; the conflict is reported (SNDKx 1 → 8)", () => {
    const warnings: ValuationWarning[] = [];
    const assets = assetRegistry.resolve([{ ref: SNDKX, decimals: 8, hints: [snapshot, jupiter] }], { nowMs: CAPTURED_MS, warn: (w) => warnings.push(w) });
    const asset = assets.get(assetKey(SNDKX))!;
    expect(asset.facts.multiplier).toEqual({ kind: "scaled-ui", config: (jupiter as ConfigHint).config });
    expect(asset.multiplierAt(CAPTURED_MS)).toBe(8);
    expect(warnings).toEqual([{ kind: "multiplier-conflict", asset: assetKey(SNDKX),
      chosen: { origin: "jupiter", observedAtMs: CAPTURED_MS, multiplier: 8 },
      ignored: { origin: "snapshot", observedAtMs: CAPTURED_MS - 86_400_000, multiplier: 1 } }]);
  });

  it("a snapshot taken after the Jupiter fetch wins, whatever the hint order", () => {
    const fresher = { ...(snapshot as ConfigHint), observedAtMs: CAPTURED_MS + 1 };
    expect(resolveOne(SNDKX, [jupiter, fresher]).multiplier).toEqual({ kind: "scaled-ui", config: fresher.config });
    expect(resolveOne(SNDKX, [fresher, jupiter]).multiplier).toEqual({ kind: "scaled-ui", config: fresher.config });
  });

  it("configs that agree at evaluation time raise no warning", () => {
    const warnings: ValuationWarning[] = [];
    const before = Date.parse("2026-11-20T09:00:00Z");   // both still 1 before the switch
    assetRegistry.resolve([{ ref: SNDKX, decimals: 8, hints: [snapshot, jupiter] }], { nowMs: before, warn: (w) => warnings.push(w) });
    expect(warnings).toEqual([]);
  });

  it("an on-chain mint read wins over a disagreeing config and reports it", () => {
    const warnings: ValuationWarning[] = [];
    const onchain: MultiplierHint = { kind: "mint-extensions", scaledUiConfig: null };
    const facts = assetRegistry.resolve([{ ref: SNDKX, decimals: 8, hints: [jupiter, onchain] }], { nowMs: CAPTURED_MS, warn: (w) => warnings.push(w) }).get(assetKey(SNDKX))!.facts;
    expect(facts).toMatchObject({ multiplier: { kind: "none" }, multiplierSource: "spl-plain" });
    expect(warnings).toMatchObject([{ chosen: { origin: "mint-account", multiplier: 1 }, ignored: { origin: "jupiter", multiplier: 8 } }]);
  });

  it("Ondo and Robinhood Chain are known to be 1; anything unrecognised stays unknown and is not valued", () => {
    expect(resolveOne(USDC, [{ kind: "issuer", issuer: "ondo" }])).toMatchObject({ multiplier: { kind: "none" }, multiplierSource: "ondo-none" });
    expect(resolveOne(RHC_TOKEN, [])).toMatchObject({ multiplier: { kind: "none" }, multiplierSource: "rhc-per-raw" });
    const unknown = assetRegistry.resolve([{ ref: SNDK, decimals: 6 }], CTX).get(assetKey(SNDK))!;
    expect(unknown.facts).toMatchObject({ multiplier: { kind: "unknown" }, multiplierSource: null });
    expect(unknown.value(1_000_000n, { basis: "per-share", usd: 79.6 }, CAPTURED_MS)).toEqual({ kind: "unpriced", reason: "multiplier-unknown" });
  });

  it("merges duplicate refs and their hints in one resolve", () => {
    const assets = assetRegistry.resolve([{ ref: SNDKX, decimals: 8, hints: [jupiter] }, { ref: SNDKX, decimals: 8, hints: [snapshot] }], CTX);
    expect(assets.size).toBe(1);
    expect(assets.get(assetKey(SNDKX))!.facts.multiplier).toEqual({ kind: "scaled-ui", config: (jupiter as ConfigHint).config });
  });
});

describe("price sources", () => {
  it("keeps each provider's unit: a per-raw quote never gets the multiplier again (DexScreener SNDK 630.67)", () => {
    const asset = assetRegistry.resolve([{ ref: SNDK, decimals: 6, hints: [{ kind: "mint-extensions", scaledUiConfig: { multiplier: 8, newMultiplier: 8, newMultiplierEffectiveTimestamp: 0 } }] }], CTX).get(assetKey(SNDK))!;
    const dexscreener = assetRegistry.quoteOf({ price: 630.67, source: "dexscreener", basis: "per-raw-unit" })!;
    const raydium = assetRegistry.quoteOf({ price: 630.67, source: "raydium", basis: "per-raw-unit" })!;
    expect(dexscreener).toEqual({ basis: "per-raw-unit", usd: 630.67, source: "dexscreener" });
    expect(raydium.source).toBe("raydium");
    expect(asset.usdPerRawUnit(dexscreener, CAPTURED_MS)).toBe(630.67);
    expect(asset.usdPerRawUnit(raydium, CAPTURED_MS)).toBe(630.67);
  });

  it("stored Robinhood Chain prices are per raw unit; unusable prices give no quote", () => {
    expect(assetRegistry.rhcStoredQuote(1.0004)).toEqual({ basis: "per-raw-unit", usd: 1.0004, source: "rhc-stored" });
    expect(assetRegistry.rhcStoredQuote(0)).toBeNull();
    expect(assetRegistry.quoteOf({ price: Number.NaN, source: "jupiter", basis: "per-share" })).toBeNull();
  });

  it("only Jupiter quotes carry a multiplier hint", () => {
    expect(multiplierHintsFromQuote({ price: 630.67, source: "dexscreener", basis: "per-raw-unit" }, CAPTURED_MS)).toEqual([]);
    expect(multiplierHintsFromQuote({ price: 79.6, source: "jupiter", basis: "per-share" }, CAPTURED_MS)).toEqual([]);
  });
});

describe("assets are plain data plus behaviour", () => {
  it("facts survive JSON and rebuild an asset that values the same", () => {
    const quote = jupiterQuote(rows[NVDAX.address]!);
    const asset = assetRegistry.resolve([{ ref: NVDAX, decimals: 8, hints: multiplierHintsFromQuote(quote, CAPTURED_MS) }], CTX).get(assetKey(NVDAX))!;
    const rebuilt = createAsset(JSON.parse(JSON.stringify(asset.facts)));
    const priced = assetRegistry.quoteOf(quote)!;
    expect(rebuilt.facts).toEqual(asset.facts);
    expect(rebuilt.value(123_456_789n, priced, CAPTURED_MS)).toEqual(asset.value(123_456_789n, priced, CAPTURED_MS));
    expect(Object.getPrototypeOf(asset)).toBe(Object.prototype);   // no class instances
  });

  it("no quote is unpriced, not zero", () => {
    expect(createAsset({ ref: USDC, decimals: 6, multiplier: { kind: "none" }, multiplierSource: "spl-plain" }).value(1n, undefined, 0))
      .toEqual({ kind: "unpriced", reason: "no-quote" });
  });

  it("reads the extension shape @solana/spl-token returns (bigint timestamp) as seconds", () => {
    expect(scaledUiConfigFromExtension({ multiplier: 1, newMultiplier: 8, newMultiplierEffectiveTimestamp: 1_795_167_000n }))
      .toEqual({ multiplier: 1, newMultiplier: 8, newMultiplierEffectiveTimestamp: 1_795_167_000 });
    expect(scaledUiConfigFromExtension(null)).toBeNull();
  });
});
