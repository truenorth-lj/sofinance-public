import { describe, expect, it } from "vitest";
import { USDC_MINT, USDT_MINT } from "@/lib/rwa-allowlist";
import { isSameAssetPair } from "./token-registry";
import { solanaStaticToken } from "./solana-registry";
import { RHC_REGISTRY } from "./rhc-registry";
import {
  isSameStockPool,
  isSameStockRegistryPair,
  isStockUnderlying,
} from "./same-stock-pair";

describe("isStockUnderlying / isSameStockRegistryPair", () => {
  it("treats USD as a cash underlying and stock tickers as stocks", () => {
    expect(isStockUnderlying("USD")).toBe(false);
    expect(isStockUnderlying("USDC")).toBe(false);
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
