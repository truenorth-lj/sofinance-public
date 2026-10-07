import { describe, expect, it } from "vitest";
import {
  estimateFeeAprPct,
  hasFreezeTag,
  hasJupiterStocksOrRwaTags,
  hasPreferredJupiterTags,
  isToken2022Program,
  matchSameAssetPair,
  matchWrapPairShape,
  parseWrapSymbol,
  qualifyRwaMint,
  TOKEN_2022_PROGRAM_ID,
} from "./rwa-pairing";

describe("parseWrapSymbol", () => {
  it("parses FOOx suffix", () => {
    expect(parseWrapSymbol("NVDAx")).toEqual({ base: "NVDA", kind: "suffix-x" });
    expect(parseWrapSymbol("SPCXx")).toEqual({ base: "SPCX", kind: "suffix-x" });
  });

  it("parses FOO-x and FOO_x", () => {
    expect(parseWrapSymbol("FOO-x")).toEqual({ base: "FOO", kind: "suffix-dash-x" });
    expect(parseWrapSymbol("FOO_x")).toEqual({ base: "FOO", kind: "suffix-underscore-x" });
  });

  it("parses xFOO prefix forms", () => {
    expect(parseWrapSymbol("xBTC")).toEqual({ base: "BTC", kind: "prefix-x" });
    expect(parseWrapSymbol("x-ETH")).toEqual({ base: "ETH", kind: "prefix-x" });
  });

  it("rejects plain tickers", () => {
    expect(parseWrapSymbol("NVDA")).toBeNull();
    expect(parseWrapSymbol("USDC")).toBeNull();
  });
});

describe("Jupiter tag helpers", () => {
  it("accepts stocks or rwa", () => {
    expect(hasJupiterStocksOrRwaTags(["stocks"])).toBe(true);
    expect(hasJupiterStocksOrRwaTags(["RWA"])).toBe(true);
    expect(hasJupiterStocksOrRwaTags(["verified", "token-2022"])).toBe(false);
    expect(hasPreferredJupiterTags(["xstocks", "stocks"])).toBe(true);
    expect(hasPreferredJupiterTags(["backpack"])).toBe(true);
    expect(hasPreferredJupiterTags(["stocks"])).toBe(false);
  });

  it("qualifies via Jupiter first, then whitelist", () => {
    expect(qualifyRwaMint({ symbol: "A", jupiterTags: ["stocks"] })).toBe("jupiter-tags");
    expect(qualifyRwaMint({ symbol: "A", onXstocksWhitelist: true })).toBe("xstocks-whitelist");
    expect(
      qualifyRwaMint({ symbol: "A", jupiterTags: ["stocks"], onXstocksWhitelist: true }),
    ).toBe("jupiter-tags");
    expect(qualifyRwaMint({ symbol: "A" })).toBeNull();
  });
});

describe("matchWrapPairShape", () => {
  it("matches FOOx/FOO and rejects stables", () => {
    expect(matchWrapPairShape("MSTRx", "MSTR").matched).toBe(true);
    expect(matchWrapPairShape("USDCx", "USDC").matched).toBe(false);
  });
});

describe("matchSameAssetPair", () => {
  it("matches MSTRx / MSTR when both are Jupiter-tagged", () => {
    const result = matchSameAssetPair(
      { symbol: "MSTRx", jupiterTags: ["xstocks", "stocks", "rwa"] },
      { symbol: "MSTR", jupiterTags: ["backpack", "stocks", "rwa"] },
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.baseSymbol).toBe("MSTR");
      expect(result.wrappedSymbol).toBe("MSTRx");
      expect(result.plainSymbol).toBe("MSTR");
      expect(result.relatedness).toBe("both-jupiter-tagged");
      expect(result.preferredTags).toBe(true);
    }
  });

  it("matches when one side is only on the xStocks whitelist", () => {
    const result = matchSameAssetPair(
      { symbol: "NVDAx", jupiterTags: ["stocks", "rwa", "xstocks"] },
      { symbol: "NVDA", jupiterTags: [], onXstocksWhitelist: true },
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.relatedness).toBe("mixed-jupiter-whitelist");
      expect(result.qualificationB).toBe("xstocks-whitelist");
    }
  });

  it("matches both-whitelisted when Jupiter tags lag", () => {
    const result = matchSameAssetPair(
      { symbol: "AAPLx", onXstocksWhitelist: true },
      { symbol: "AAPL", onXstocksWhitelist: true },
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.relatedness).toBe("both-whitelisted");
    }
  });

  it("rejects RWA vs USDC", () => {
    const result = matchSameAssetPair(
      { symbol: "NVDAx", jupiterTags: ["stocks"] },
      { symbol: "USDC", jupiterTags: ["stable"] },
    );
    expect(result.matched).toBe(false);
  });

  it("rejects unrelated meme ticker collision without Jupiter/whitelist", () => {
    const result = matchSameAssetPair(
      { symbol: "HOODx", jupiterTags: ["stocks", "rwa", "xstocks"] },
      { symbol: "HOOD", jupiterTags: ["unknown"] },
    );
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toMatch(/mint B|lack Jupiter/i);
  });

  it("rejects stablecoin wrap pairs", () => {
    const result = matchSameAssetPair(
      { symbol: "USDCx", jupiterTags: ["stocks"] },
      { symbol: "USDC", jupiterTags: ["stocks"] },
    );
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toMatch(/stablecoin/i);
  });

  it("rejects identical symbols", () => {
    const result = matchSameAssetPair(
      { symbol: "USDC", jupiterTags: ["stocks"] },
      { symbol: "USDC", jupiterTags: ["stocks"] },
    );
    expect(result.matched).toBe(false);
  });

  it("rejects pools with no Jupiter tags and no whitelist", () => {
    const result = matchSameAssetPair(
      { symbol: "ABCx", name: "Random Wrap" },
      { symbol: "ABC", name: "ABC" },
    );
    expect(result.matched).toBe(false);
  });

  it("does not use name heuristics as primary (tokenized names alone are insufficient)", () => {
    const result = matchSameAssetPair(
      { symbol: "HOODx", name: "Robinhood xStock" },
      { symbol: "HOOD", name: "Robinhood - Backpack Securities" },
    );
    expect(result.matched).toBe(false);
  });
});

describe("estimateFeeAprPct", () => {
  it("annualizes 24h fees over TVL", () => {
    expect(estimateFeeAprPct(100, 10_000)).toBeCloseTo(365, 6);
  });

  it("returns null for zero or invalid TVL", () => {
    expect(estimateFeeAprPct(10, 0)).toBeNull();
    expect(estimateFeeAprPct(10, -1)).toBeNull();
    expect(estimateFeeAprPct(Number.NaN, 100)).toBeNull();
  });
});

describe("token flags", () => {
  it("detects Token-2022 and freeze tags", () => {
    expect(isToken2022Program(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(isToken2022Program("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe(false);
    expect(hasFreezeTag(["hasFreeze"])).toBe(true);
    expect(hasFreezeTag(["hasfreeze"])).toBe(true);
    expect(hasFreezeTag([])).toBe(false);
  });
});
