import { describe, expect, it } from "vitest";
import { CBBTC_MINT, HSOL_MINT, NATIVE_SOL_MINT, USDC_MINT, USDT_MINT, WBTC_PORTAL_MINT } from "@/lib/rwa-allowlist";
import { isSameAssetPair } from "./token-registry";
import { solanaStaticToken } from "./solana-registry";
import { RHC_REGISTRY } from "./rhc-registry";
import {
  isBtcPool,
  isCuratedCryptoPool,
  isLstPool,
  isPublicSeoPool,
  isSameStockPool,
  isSameStockRegistryPair,
  isStockUnderlying,
} from "./same-stock-pair";

describe("isStockUnderlying / isSameStockRegistryPair", () => {
  it("treats USD as a cash underlying and stock tickers as stocks", () => {
    expect(isStockUnderlying("USD")).toBe(false);
    expect(isStockUnderlying("USDC")).toBe(false);
    expect(isStockUnderlying("SOL")).toBe(false);
    expect(isStockUnderlying("BTC")).toBe(false);
    expect(isStockUnderlying("btc")).toBe(false);
    expect(isStockUnderlying("TSLA")).toBe(true);
    expect(isStockUnderlying("NVDA")).toBe(true);
  });

  it("the curated USDC/USDT tokens are a same-asset pair but not a same-stock pair", () => {
    const usdc = solanaStaticToken(USDC_MINT)!;
    const usdt = solanaStaticToken(USDT_MINT)!;
    expect(isSameAssetPair(usdc, usdt)).toBe(true);
    expect(isSameStockRegistryPair(usdc, usdt)).toBe(false);
  });

  it("a Robinhood + Ondo token of one underlying is a same-stock pair", () => {
    const tsla = RHC_REGISTRY.tokens.filter((token) => token.underlying === "TSLA");
    expect(tsla).toHaveLength(2);
    expect(isSameStockRegistryPair(tsla[0]!, tsla[1]!)).toBe(true);
  });
});

describe("isSameStockPool", () => {
  it("accepts Solana stock wraps and Robinhood Chain stock/stock-token pools", () => {
    expect(isSameStockPool({
      chain: "solana", mintA: "tsla-mint", mintB: "tslax-mint", symbolA: "TSLAx", symbolB: "TSLA",
    })).toBe(true);
    expect(isSameStockPool({
      chain: "solana", mintA: "spcx-mint", mintB: "spcxx-mint", symbolA: "SPCXx", symbolB: "SPCX",
    })).toBe(true);
    const nvda = RHC_REGISTRY.tokens.filter((token) => token.underlying === "NVDA");
    expect(nvda).toHaveLength(2);
    expect(isSameStockPool({
      chain: "robinhood", mintA: nvda[0]!.address, mintB: nvda[1]!.address, symbolA: nvda[0]!.symbol, symbolB: nvda[1]!.symbol,
    })).toBe(true);
  });

  it("rejects the curated USDC/USDT pool and other non-stock same-asset pairs", () => {
    expect(isSameStockPool({
      chain: "solana", mintA: USDC_MINT, mintB: USDT_MINT, symbolA: "USDC", symbolB: "USDT",
    })).toBe(false);
    expect(isSameStockPool({
      chain: "solana", mintA: "cbbtc-mint", mintB: "wbtc-mint", symbolA: "cbBTC", symbolB: "WBTC",
    })).toBe(false);
    expect(isSameStockPool({
      chain: "robinhood", mintA: "0xusdc", mintB: "0xusdcon", symbolA: "USDC", symbolB: "USDCon",
    })).toBe(false);
  });

  it("accepts an RHC stock wrap by ticker when the mints are not in the registry yet", () => {
    expect(isSameStockPool({
      chain: "robinhood", mintA: "0x-nvda-test", mintB: "0x-nvdaon-test", symbolA: "NVDA", symbolB: "NVDAon",
    })).toBe(true);
  });
});

describe("SOL/hSOL is an LST pair, not a same-stock pair, and is still a public SEO pool", () => {
  const solHsol = {
    chain: "solana" as const, mintA: NATIVE_SOL_MINT, mintB: HSOL_MINT, symbolA: "SOL", symbolB: "hSOL",
  };

  it("pairs as same-asset SOL from different issuers, but not as a stock", () => {
    const sol = solanaStaticToken(NATIVE_SOL_MINT)!;
    const hsol = solanaStaticToken(HSOL_MINT)!;
    expect(isSameAssetPair(sol, hsol)).toBe(true);
    expect(isSameStockRegistryPair(sol, hsol)).toBe(false);
    expect(isSameStockPool(solHsol)).toBe(false);
    expect(isLstPool(solHsol)).toBe(true);
    expect(isLstPool({ mintA: HSOL_MINT, mintB: NATIVE_SOL_MINT })).toBe(true);
    expect(isPublicSeoPool(solHsol)).toBe(true);
  });

  it("does not mark USDC/USDT or a stock wrap as an LST pool", () => {
    expect(isLstPool({ mintA: USDC_MINT, mintB: USDT_MINT })).toBe(false);
    expect(isPublicSeoPool({
      chain: "solana", mintA: USDC_MINT, mintB: USDT_MINT, symbolA: "USDC", symbolB: "USDT",
    })).toBe(false);
    expect(isPublicSeoPool({
      chain: "solana", mintA: "tsla-mint", mintB: "tslax-mint", symbolA: "TSLAx", symbolB: "TSLA",
    })).toBe(true);
  });
});

describe("cbBTC/WBTC is a BTC pair, not a same-stock pair, and is a public SEO pool", () => {
  const cbbtcWbtc = {
    chain: "solana" as const, mintA: CBBTC_MINT, mintB: WBTC_PORTAL_MINT, symbolA: "cbBTC", symbolB: "WBTC",
  };

  it("pairs as same-asset BTC from different issuers, but not as a stock", () => {
    const cbbtc = solanaStaticToken(CBBTC_MINT)!;
    const wbtc = solanaStaticToken(WBTC_PORTAL_MINT)!;
    expect(cbbtc).toMatchObject({ symbol: "cbBTC", issuer: "coinbase", underlying: "BTC" });
    expect(wbtc).toMatchObject({ symbol: "WBTC", issuer: "wormhole-portal", underlying: "BTC" });
    expect(isSameAssetPair(cbbtc, wbtc)).toBe(true);
    expect(isSameStockRegistryPair(cbbtc, wbtc)).toBe(false);
    expect(isSameStockPool(cbbtcWbtc)).toBe(false);
    expect(isLstPool(cbbtcWbtc)).toBe(false);
    expect(isBtcPool(cbbtcWbtc)).toBe(true);
    expect(isBtcPool({ mintA: WBTC_PORTAL_MINT, mintB: CBBTC_MINT })).toBe(true);
    expect(isCuratedCryptoPool(cbbtcWbtc)).toBe(true);
    expect(isPublicSeoPool(cbbtcWbtc)).toBe(true);
    expect(isPublicSeoPool({ ...cbbtcWbtc, mintA: WBTC_PORTAL_MINT, mintB: CBBTC_MINT })).toBe(true);
  });

  it("does not mark other BTC mints, other crypto pairs or USDC/USDT as a public BTC pool", () => {
    // BitGo's native WBTC mint is a different token from the Wormhole (Portal) one.
    const nativeWbtc = "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ";
    expect(isBtcPool({ mintA: CBBTC_MINT, mintB: nativeWbtc })).toBe(false);
    expect(isBtcPool({ mintA: CBBTC_MINT, mintB: CBBTC_MINT })).toBe(false);
    expect(isBtcPool({ mintA: CBBTC_MINT, mintB: USDC_MINT })).toBe(false);
    expect(isBtcPool({ mintA: NATIVE_SOL_MINT, mintB: HSOL_MINT })).toBe(false);
    expect(isPublicSeoPool({ chain: "solana", mintA: CBBTC_MINT, mintB: nativeWbtc, symbolA: "cbBTC", symbolB: "WBTC" })).toBe(false);
    expect(isPublicSeoPool({ chain: "solana", mintA: USDC_MINT, mintB: USDT_MINT, symbolA: "USDC", symbolB: "USDT" })).toBe(false);
  });
});
