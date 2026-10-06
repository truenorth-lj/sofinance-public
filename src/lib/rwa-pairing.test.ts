import { describe, expect, it } from "vitest";
import {
  estimateFeeAprPct,
  hasFreezeTag,
  isToken2022Program,
  matchSameAssetPair,
  namesShareCompanyStem,
  parseWrapSymbol,
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

describe("matchSameAssetPair", () => {
  it("matches MSTRx / MSTR with Backpack counterparty", () => {
    const result = matchSameAssetPair(
      { symbol: "MSTRx", name: "MicroStrategy xStock", extensionsText: '{"tips":{"text":"Backed"}}' },
      { symbol: "MSTR", name: "Strategy - Backpack Securities" },
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.baseSymbol).toBe("MSTR");
      expect(result.wrappedSymbol).toBe("MSTRx");
      expect(result.plainSymbol).toBe("MSTR");
      expect(result.relatedness).toBe("both-tokenized");
    }
  });

  it("matches NVDAx / NVDA when plain name is the ticker", () => {
    const result = matchSameAssetPair(
      { symbol: "NVDAx", name: "NVIDIA xStock" },
      { symbol: "NVDA", name: "NVDA" },
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.relatedness).toBe("plain-is-ticker");
      expect(result.wrapKind).toBe("suffix-x");
    }
  });

  it("matches FOO-x / FOO with shared company stem", () => {
    const result = matchSameAssetPair(
      { symbol: "INTC-x", name: "Intel xStock" },
      { symbol: "INTC", name: "Intel Corp" },
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.wrapKind).toBe("suffix-dash-x");
      expect(result.relatedness).toBe("shared-stem");
    }
  });

  it("rejects RWA vs USDC", () => {
    const result = matchSameAssetPair(
      { symbol: "NVDAx", name: "NVIDIA xStock" },
      { symbol: "USDC", name: "USD Coin" },
    );
    expect(result.matched).toBe(false);
  });

  it("rejects unrelated meme ticker collision", () => {
    const result = matchSameAssetPair(
      { symbol: "HOODx", name: "Robinhood xStock" },
      { symbol: "HOOD", name: "foreskin" },
    );
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toMatch(/unrelated/i);
  });

  it("rejects stablecoin wrap pairs", () => {
    const result = matchSameAssetPair(
      { symbol: "USDCx", name: "USDC xStock" },
      { symbol: "USDC", name: "USD Coin" },
    );
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toMatch(/stablecoin/i);
  });

  it("rejects identical symbols that only differ by whitespace after trim equality path", () => {
    const result = matchSameAssetPair(
      { symbol: "USDC", name: "USD Coin" },
      { symbol: "USDC", name: "USD Coin" },
    );
    expect(result.matched).toBe(false);
  });

  it("rejects pools with no tokenized evidence", () => {
    const result = matchSameAssetPair(
      { symbol: "ABCx", name: "Random Wrap" },
      { symbol: "ABC", name: "ABC" },
    );
    expect(result.matched).toBe(false);
  });
});

describe("namesShareCompanyStem", () => {
  it("detects shared Intel stem", () => {
    expect(namesShareCompanyStem("Intel xStock", "Intel - Backpack Securities")).toBe(true);
  });

  it("rejects unrelated names", () => {
    expect(namesShareCompanyStem("Robinhood xStock", "foreskin")).toBe(false);
  });
});

describe("estimateFeeAprPct", () => {
  it("annualizes 24h fees over TVL", () => {
    // 100 fees / 10000 TVL * 365 * 100 = 365%
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
