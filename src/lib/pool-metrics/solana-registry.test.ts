import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasPreferredJupiterTags, matchWrapPairShape, qualifyRwaMint,
  type MintHints, type PairingResult, type Relatedness,
} from "../rwa-pairing";
import { USDC_MINT, USDT_MINT } from "../rwa-allowlist";
import {
  matchSameAssetPair, SOLANA_PLAIN_TICKER_ISSUER, SOLANA_WRAPPED_TICKER_ISSUER, solanaRegistryEntries, solanaStaticToken,
} from "./solana-registry";
import { pairRegistryTokens } from "./token-registry";

// The pre-registry implementation, verbatim (rwa-pairing.ts before the refactor): the oracle.
/**
 * Decide whether mint A/B form a same-underlying RWA wrap pair.
 * Pure function — safe for unit tests without network.
 */
function legacyMatchSameAssetPair(mintA: MintHints, mintB: MintHints): PairingResult {
  const shape = matchWrapPairShape(mintA.symbol || "", mintB.symbol || "");
  if (!shape.matched) return shape;

  const { baseSymbol, wrappedSymbol, plainSymbol, wrapKind, wrappedSide } = shape;


  const qualificationA = qualifyRwaMint(mintA);
  const qualificationB = qualifyRwaMint(mintB);
  if (!qualificationA || !qualificationB) {
    const missing =
      !qualificationA && !qualificationB
        ? "both mints"
        : !qualificationA
          ? "mint A"
          : "mint B";
    return {
      matched: false,
      reason: `${missing} lack Jupiter stocks/rwa tags and are not on the xStocks whitelist`,
    };
  }

  let relatedness: Relatedness;
  if (qualificationA === "jupiter-tags" && qualificationB === "jupiter-tags") {
    relatedness = "both-jupiter-tagged";
  } else if (qualificationA === "xstocks-whitelist" && qualificationB === "xstocks-whitelist") {
    relatedness = "both-whitelisted";
  } else {
    relatedness = "mixed-jupiter-whitelist";
  }

  return {
    matched: true,
    baseSymbol,
    wrappedSymbol,
    plainSymbol,
    wrapKind,
    wrappedSide,
    qualificationA,
    qualificationB,
    relatedness,
    preferredTags:
      hasPreferredJupiterTags(mintA.jupiterTags) || hasPreferredJupiterTags(mintB.jupiterTags),
  };
}


const inputs = JSON.parse(readFileSync(fileURLToPath(new URL("./__fixtures__/solana-discovery-inputs.json", import.meta.url)), "utf8")) as {
  responses: Record<string, { body: { data?: { data?: { mintA?: { symbol?: string }; mintB?: { symbol?: string } }[] } } }>;
};
const scanned = Object.entries(inputs.responses).filter(([url]) => url.includes("raydium"))
  .flatMap(([, value]) => value.body.data?.data ?? []).flatMap((pool) => [pool.mintA?.symbol ?? "", pool.mintB?.symbol ?? ""]);
const edge = ["SPCX", "SPCXx", "SPC", "NVDA", "NVDAx", "nvdax", " NVDAx ", "NVDA-x", "NVDA_x", "xNVDA", "x-NVDA", "x_NVDA", "XNVDA",
  "USDC", "USDCx", "USDT", "xUSDT", "SOL", "A", "Ax", "ABCDEFGHIJKL", "ABCDEFGHIJKLx", "ABCDEFGHIJKLM", "ABCDEFGHIJKLMx", "", "x", "xx", "XX", "FOOX", "FOOx"];
const symbols = [...new Set([...scanned, ...edge])];
const hints: Omit<MintHints, "symbol">[] = [
  {}, { jupiterTags: ["stocks"] }, { jupiterTags: ["RWA", "xstocks"] }, { onXstocksWhitelist: true },
  { jupiterTags: ["backpack"], onXstocksWhitelist: true }, { jupiterTags: ["verified"] },
];

describe("Solana registry pairing = the earlier FOOx/FOO rule", () => {
  it(`matches the oracle on every pair of ${symbols.length} tickers x ${hints.length}^2 verifications`, () => {
    let compared = 0, matched = 0;
    for (const a of symbols) for (const b of symbols) for (const ha of hints) for (const hb of hints) {
      const mintA = { symbol: a, ...ha }, mintB = { symbol: b, ...hb };
      const expected = legacyMatchSameAssetPair(mintA, mintB);
      expect(matchSameAssetPair({ ...mintA, address: "A" }, { ...mintB, address: "B" })).toEqual(expected);
      compared += 1; if (expected.matched) matched += 1;
    }
    expect(matched).toBeGreaterThan(100);
    expect(compared).toBe(symbols.length ** 2 * hints.length ** 2);
  });

  it("reads a ticker as wrapped and plain where both apply; none when unverified", () => {
    expect(solanaRegistryEntries({ address: "m", symbol: "SPCXx", jupiterTags: ["stocks"] }).map((t) => [t.issuer, t.underlying]))
      .toEqual([[SOLANA_WRAPPED_TICKER_ISSUER, "SPCX"], [SOLANA_PLAIN_TICKER_ISSUER, "SPCXX"]]);
    expect(solanaRegistryEntries({ address: "m", symbol: "USDCx", jupiterTags: ["stocks"] }).map((t) => t.issuer)).toEqual([SOLANA_PLAIN_TICKER_ISSUER]);
    expect(solanaRegistryEntries({ address: "m", symbol: "NVDAx" })).toEqual([]);
  });

  it("the curated USDC / USDT pool pairs by the same rule (USD, Circle vs Tether)", () => {
    const pair = pairRegistryTokens([solanaStaticToken(USDC_MINT)!], [solanaStaticToken(USDT_MINT)!]);
    expect(pair?.underlying).toBe("USD");
    expect(pairRegistryTokens([solanaStaticToken(USDC_MINT)!], [solanaStaticToken(USDC_MINT)!])).toBeNull();
  });
});
