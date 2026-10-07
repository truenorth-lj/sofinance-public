/**
 * Same-underlying RWA pair detection for Raydium CLMM pools.
 *
 * ## Pairing rule (documented)
 *
 * A pool qualifies as a same-asset RWA pair when **all** of the following hold:
 *
 * 1. **Symbol wrap pair** (after trim; case-insensitive):
 *    - One side matches `BASEx`, `BASE-x`, or `BASE_x` (suffix), or
 *      `xBASE` / `x-BASE` / `x_BASE` (prefix), where `BASE` is 2–12 alphanumeric chars.
 *    - The other side equals `BASE` exactly (the plain ticker). A plain ticker that itself
 *      ends in `X` (e.g. `SPCX`) may also match `parseWrapSymbol` in isolation; when both
 *      sides look wrapped, prefer the longer wrap of the shorter plain ticker
 *      (`SPCXx`/`SPCX`) over rejecting as "both wrapped".
 *    - Examples: `SPCXx`/`SPCX`, `MSTRx`/`MSTR`, `NVDAx`/`NVDA`, `FOO-x`/`FOO`.
 * 2. **Not a stablecoin base**: `BASE` is not USDC/USDT/etc. (excludes spam wrap-of-stable pools).
 * 3. **Primary — Jupiter Tokens API tags**: **both** mints have tags including `stocks` **or**
 *    `rwa` (case-insensitive). Tags such as `xstocks` / `backpack` are preferred when present
 *    but are not required.
 * 4. **Secondary — Backed xStocks whitelist**: a mint on the Backed xStocks public assets list
 *    (Solana deployment address) also qualifies even if Jupiter tags lag.
 *
 * Name / string heuristics are **not** used as the primary filter (they previously matched
 * unrelated meme tickers that collided on the bare symbol).
 *
 * Pools like `NVDAx`/`USDC` or `MSTRx`/`SOL` fail rule 1. Unrelated meme tickers that
 * only collide on the bare symbol fail rules 3–4.
 *
 * ## Yield / fee APR labeling
 *
 * - `raydiumFeeApr24h`: Raydium API `day.feeApr` when present (vendor-published).
 * - `estimatedFeeAprPct`: `(volumeFee24h / tvl) * 365 * 100` when TVL > 0.
 *   This is an **annualized fee APR estimate from 24h fees ÷ TVL**, not a guarantee of
 *   LP returns (ignores IL, range, rewards, and fee share). Prefer Raydium’s published
 *   value when both exist; surface both and label the source in UI/MCP.
 */

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const STABLECOIN_BASES = new Set([
  "USDC", "USDT", "USD1", "PYUSD", "DAI", "USDS", "USDE", "FDUSD", "USD", "USDG", "AUSD",
]);

/** Jupiter tags that qualify a mint as stocks/RWA (primary filter). */
export const JUPITER_RWA_TAGS = new Set(["stocks", "rwa"]);

/** Preferred Jupiter tags (not required; used for ranking / labels). */
export const JUPITER_PREFERRED_TAGS = new Set(["xstocks", "backpack"]);

export type WrapKind = "suffix-x" | "suffix-dash-x" | "suffix-underscore-x" | "prefix-x";

export type RwaQualificationSource = "jupiter-tags" | "xstocks-whitelist";

export type Relatedness =
  | "both-jupiter-tagged"
  | "both-whitelisted"
  | "mixed-jupiter-whitelist";

export type PairingMatch = {
  matched: true;
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
  wrapKind: WrapKind;
  wrappedSide: "A" | "B";
  /** How each side was qualified as RWA. */
  qualificationA: RwaQualificationSource;
  qualificationB: RwaQualificationSource;
  relatedness: Relatedness;
  /** True when at least one side carries preferred Jupiter tags (xstocks / backpack). */
  preferredTags: boolean;
};

export type PairingReject = { matched: false; reason: string };

export type PairingResult = PairingMatch | PairingReject;

export type MintHints = {
  symbol: string;
  name?: string | null;
  /** Jupiter Tokens API `tags` for this mint (cached). */
  jupiterTags?: string[] | null;
  /** True when mint is a Solana deployment on Backed xStocks public assets. */
  onXstocksWhitelist?: boolean;
};

/** Parse FOOx / FOO-x / FOO_x / xFOO style wrap symbols. */
export function parseWrapSymbol(symbol: string): { base: string; kind: WrapKind } | null {
  const s = symbol.trim();
  if (!s) return null;
  let m = /^([A-Za-z0-9]{2,12})-x$/i.exec(s);
  if (m) return { base: m[1]!.toUpperCase(), kind: "suffix-dash-x" };
  m = /^([A-Za-z0-9]{2,12})_x$/i.exec(s);
  if (m) return { base: m[1]!.toUpperCase(), kind: "suffix-underscore-x" };
  m = /^([A-Za-z0-9]{2,12})x$/i.exec(s);
  if (m) return { base: m[1]!.toUpperCase(), kind: "suffix-x" };
  m = /^x-([A-Za-z0-9]{2,12})$/i.exec(s);
  if (m) return { base: m[1]!.toUpperCase(), kind: "prefix-x" };
  m = /^x_([A-Za-z0-9]{2,12})$/i.exec(s);
  if (m) return { base: m[1]!.toUpperCase(), kind: "prefix-x" };
  m = /^x([A-Za-z0-9]{2,12})$/i.exec(s);
  if (m) return { base: m[1]!.toUpperCase(), kind: "prefix-x" };
  return null;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** True when Jupiter tags include `stocks` or `rwa`. */
export function hasJupiterStocksOrRwaTags(tags?: string[] | null): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => typeof t === "string" && JUPITER_RWA_TAGS.has(normalizeTag(t)));
}

/** True when Jupiter tags include preferred `xstocks` or `backpack`. */
export function hasPreferredJupiterTags(tags?: string[] | null): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => typeof t === "string" && JUPITER_PREFERRED_TAGS.has(normalizeTag(t)));
}

/**
 * Qualify a mint as RWA: Jupiter stocks/rwa tags (primary) or Backed xStocks whitelist (secondary).
 * Prefer reporting Jupiter when both apply.
 */
export function qualifyRwaMint(hints: MintHints): RwaQualificationSource | null {
  if (hasJupiterStocksOrRwaTags(hints.jupiterTags)) return "jupiter-tags";
  if (hints.onXstocksWhitelist) return "xstocks-whitelist";
  return null;
}


export type WrapPairShape = {
  matched: true;
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
  wrapKind: WrapKind;
  wrappedSide: "A" | "B";
};

function wrapPairMatch(
  wrapped: string,
  plain: string,
  wrap: { base: string; kind: WrapKind },
  wrappedSide: "A" | "B",
): WrapPairShape | PairingReject {
  if (STABLECOIN_BASES.has(wrap.base)) {
    return { matched: false, reason: `stablecoin base ${wrap.base} excluded` };
  }
  return {
    matched: true,
    baseSymbol: wrap.base,
    wrappedSymbol: wrapped,
    plainSymbol: plain,
    wrapKind: wrap.kind,
    wrappedSide,
  };
}

/**
 * Structural FOOx/FOO (or xFOO/FOO) wrap check + stablecoin exclusion only.
 * Does not consult Jupiter tags or the xStocks whitelist.
 *
 * When both symbols match {@link parseWrapSymbol} (e.g. `SPCX` → SPC and `SPCXx` → SPCX),
 * accept the longer symbol as the wrap of the shorter if its parsed base equals the
 * other symbol exactly — plain tickers that end in X are not rejected solely for that.
 */
export function matchWrapPairShape(
  symbolA: string,
  symbolB: string,
): WrapPairShape | PairingReject {
  const a = (symbolA || "").trim();
  const b = (symbolB || "").trim();
  if (!a || !b) return { matched: false, reason: "missing symbol" };
  if (a.toUpperCase() === b.toUpperCase()) {
    return { matched: false, reason: "identical symbols (not wrap vs plain)" };
  }

  const wrapA = parseWrapSymbol(a);
  const wrapB = parseWrapSymbol(b);
  const aUpper = a.toUpperCase();
  const bUpper = b.toUpperCase();

  // Prefer wrap(plain) even when the plain ticker itself ends in X and looks wrapped.
  const aWrapsB = Boolean(wrapA && wrapA.base === bUpper);
  const bWrapsA = Boolean(wrapB && wrapB.base === aUpper);

  if (aWrapsB && bWrapsA) {
    // Pathological mutual wrap (e.g. equal-length ambiguity); reject.
    return { matched: false, reason: "both symbols look wrapped" };
  }
  if (aWrapsB && wrapA) {
    return wrapPairMatch(a, b, wrapA, "A");
  }
  if (bWrapsA && wrapB) {
    return wrapPairMatch(b, a, wrapB, "B");
  }
  if (wrapA && wrapB) {
    return { matched: false, reason: "both symbols look wrapped" };
  }
  return { matched: false, reason: "symbols are not a FOOx/FOO (or xFOO/FOO) wrap pair" };
}

/**
 * Decide whether mint A/B form a same-underlying RWA wrap pair.
 * Pure function — safe for unit tests without network.
 */
export function matchSameAssetPair(mintA: MintHints, mintB: MintHints): PairingResult {
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

/**
 * Annualized fee APR estimate from 24h fees and TVL.
 * Formula: (fee24hUsd / tvlUsd) * 365 * 100. Returns null when TVL <= 0.
 */
export function estimateFeeAprPct(fee24hUsd: number, tvlUsd: number): number | null {
  if (!Number.isFinite(fee24hUsd) || !Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;
  if (fee24hUsd < 0) return null;
  return (fee24hUsd / tvlUsd) * 365 * 100;
}

export const FEE_APR_ESTIMATE_LABEL =
  "Estimated fee APR = (24h pool fees USD / TVL USD) × 365 × 100. Not LP return; ignores IL, range, and rewards.";

export const PAIRING_RULE_SUMMARY =
  "FOOx/FOO (or FOO-x / xFOO) symbol wrap + both mints Jupiter-tagged (stocks|rwa) or on Backed xStocks whitelist; stables excluded.";

export function isToken2022Program(programId?: string | null): boolean {
  return (programId || "") === TOKEN_2022_PROGRAM_ID;
}

export function hasFreezeTag(tags?: string[] | null): boolean {
  return Array.isArray(tags) && tags.some((t) => t.toLowerCase() === "hasfreeze");
}
