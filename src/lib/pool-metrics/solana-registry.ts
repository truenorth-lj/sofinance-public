import {
  hasPreferredJupiterTags,
  matchWrapPairShape,
  parseWrapSymbol,
  qualifyRwaMint,
  STABLECOIN_BASES,
  type MintHints,
  type PairingResult,
  type Relatedness,
  type RwaQualificationSource,
  type WrapKind,
} from "../rwa-pairing";
import { USDC_MINT, USDT_MINT } from "../rwa-allowlist";
import { pairRegistryTokens, type RegistryToken } from "./token-registry";

/**
 * Solana side of the token registry. Solana tokenized stocks carry no on-chain issuer identity the app can
 * check, so a mint's registry entries come from what the discovery already trusts:
 * - verification: Jupiter `stocks` / `rwa` tags, else the Backed xStocks list (`qualifyRwaMint`);
 * - underlying + issuer from the ticker convention: a wrapped ticker (`NVDAx`, `NVDA-x`, `xNVDA`) is the
 *   wrapping issuer's token for `NVDA`; a plain ticker (`NVDA`) is the other issuer's. A ticker can read
 *   both ways (`SPCXx` wraps `SPCX`; `SPCX` alone could wrap `SPC`), so a mint may have two entries.
 * Stablecoin bases are never wrapped underlyings (rule 2 in `rwa-pairing.ts`).
 *
 * Entries are generated per discovery run from the Raydium scan, so new mints still appear without a code
 * change. The generic rule (same chain, same underlying, different issuer) then gives exactly the
 * FOOx / FOO pairs the earlier rule did (golden + oracle tests).
 */
export const SOLANA_WRAPPED_TICKER_ISSUER = "solana:wrapped-ticker";
export const SOLANA_PLAIN_TICKER_ISSUER = "solana:plain-ticker";

export type SolanaRegistryToken = RegistryToken & {
  chain: "solana";
  /** Set on the wrapped-ticker reading. */
  wrapKind: WrapKind | null;
  qualification: RwaQualificationSource | "allowlist";
  jupiterTags: readonly string[];
};

export type SolanaMintInput = MintHints & { address: string };

/** Registry entries for one Raydium mint; none when it is not verified as an RWA token. */
export function solanaRegistryEntries(mint: SolanaMintInput): SolanaRegistryToken[] {
  const qualification = qualifyRwaMint(mint);
  const symbol = (mint.symbol || "").trim();
  if (!qualification || !symbol) return [];
  const tags = mint.jupiterTags ?? [];
  const verification = qualification === "jupiter-tags"
    ? { method: "jupiter-tags" as const, tags }
    : { method: "xstocks-whitelist" as const };
  const base = { chain: "solana" as const, address: mint.address, symbol, verification, qualification, jupiterTags: tags };
  const entries: SolanaRegistryToken[] = [];
  const wrap = parseWrapSymbol(symbol);
  if (wrap && !STABLECOIN_BASES.has(wrap.base))
    entries.push({ ...base, issuer: SOLANA_WRAPPED_TICKER_ISSUER, underlying: wrap.base, wrapKind: wrap.kind });
  entries.push({ ...base, issuer: SOLANA_PLAIN_TICKER_ISSUER, underlying: symbol.toUpperCase(), wrapKind: null });
  return entries;
}

/** Curated Solana tokens (the USDC / USDT CLMM allowlist pool): issuer identity is the mint itself. */
export const SOLANA_STATIC_TOKENS: readonly SolanaRegistryToken[] = Object.freeze([
  { chain: "solana", address: USDC_MINT, symbol: "USDC", issuer: "circle", underlying: "USD", verification: { method: "allowlist" },
    wrapKind: null, qualification: "allowlist", jupiterTags: [] },
  { chain: "solana", address: USDT_MINT, symbol: "USDT", issuer: "tether", underlying: "USD", verification: { method: "allowlist" },
    wrapKind: null, qualification: "allowlist", jupiterTags: [] },
]);

export function solanaStaticToken(address: string): SolanaRegistryToken | undefined {
  return SOLANA_STATIC_TOKENS.find((token) => token.address === address);
}

function relatednessOf(a: RwaQualificationSource, b: RwaQualificationSource): Relatedness {
  if (a === "jupiter-tags" && b === "jupiter-tags") return "both-jupiter-tagged";
  if (a === "xstocks-whitelist" && b === "xstocks-whitelist") return "both-whitelisted";
  return "mixed-jupiter-whitelist";
}

/**
 * Same-underlying RWA pair for two Raydium mints, through the registry and the generic pairing rule.
 * Rejections keep the earlier reasons: the ticker-shape reason first, then the missing verification.
 */
export function matchSameAssetPair(mintA: MintHints & { address?: string }, mintB: MintHints & { address?: string }): PairingResult {
  const pair = pairRegistryTokens(
    solanaRegistryEntries({ ...mintA, address: mintA.address ?? "mint-a" }),
    solanaRegistryEntries({ ...mintB, address: mintB.address ?? "mint-b" }),
  );
  if (!pair || pair.a.qualification === "allowlist" || pair.b.qualification === "allowlist") {
    const shape = matchWrapPairShape(mintA.symbol || "", mintB.symbol || "");
    if (!shape.matched) return shape;
    const qualifiedA = !!qualifyRwaMint(mintA), qualifiedB = !!qualifyRwaMint(mintB);
    const missing = !qualifiedA && !qualifiedB ? "both mints" : !qualifiedA ? "mint A" : "mint B";
    return { matched: false, reason: `${missing} lack Jupiter stocks/rwa tags and are not on the xStocks whitelist` };
  }
  const wrappedSide = pair.a.issuer === SOLANA_WRAPPED_TICKER_ISSUER ? "A" : "B";
  const wrapped = wrappedSide === "A" ? pair.a : pair.b, plain = wrappedSide === "A" ? pair.b : pair.a;
  const qualificationA = pair.a.qualification as RwaQualificationSource, qualificationB = pair.b.qualification as RwaQualificationSource;
  return {
    matched: true,
    baseSymbol: pair.underlying,
    wrappedSymbol: wrapped.symbol,
    plainSymbol: plain.symbol,
    wrapKind: wrapped.wrapKind!,
    wrappedSide,
    qualificationA,
    qualificationB,
    relatedness: relatednessOf(qualificationA, qualificationB),
    preferredTags: hasPreferredJupiterTags(mintA.jupiterTags) || hasPreferredJupiterTags(mintB.jupiterTags),
  };
}
