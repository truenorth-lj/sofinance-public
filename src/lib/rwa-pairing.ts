/**
 * Same-underlying RWA pair detection for Raydium CLMM pools.
 *
 * ## Pairing rule (documented)
 *
 * A pool qualifies as a same-asset RWA pair when **all** of the following hold:
 *
 * 1. **Symbol wrap pair** (after trim; case-insensitive):
 *    - Exactly one side matches `BASEx`, `BASE-x`, or `BASE_x` (suffix), or
 *      `xBASE` / `x-BASE` / `x_BASE` (prefix), where `BASE` is 2–12 alphanumeric chars.
 *    - The other side equals `BASE` exactly.
 *    - Examples: `SPCXx`/`SPCX`, `MSTRx`/`MSTR`, `NVDAx`/`NVDA`, `FOO-x`/`FOO`.
 * 2. **Not a stablecoin base**: `BASE` is not USDC/USDT/etc. (excludes spam wrap-of-stable pools).
 * 3. **Tokenized-stock evidence** on at least one mint name or Raydium `extensions` text:
 *    matches `/xstock|backed|backpack|tokeni[sz]ed|securities/i` (xStocks / Backpack style).
 * 4. **Relatedness** (excludes FOOx vs unrelated meme with the same ticker):
 *    - Both mints have tokenized-stock evidence, **or**
 *    - The non-wrapped mint shares a significant name stem (≥5 chars) with the wrapped
 *      mint’s company words (after stripping xStock/Backed/Backpack boilerplate), **or**
 *    - The non-wrapped mint’s entire name equals `BASE` (ticker-as-name).
 *
 * Pools like `NVDAx`/`USDC` or `MSTRx`/`SOL` fail rule 1. Unrelated meme tickers that
 * only collide on the bare symbol fail rule 4.
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

const TOKENIZED_RE = /xstock|backed\.?fi|\bbacked\b|backpack|tokeni[sz]ed|\bsecurities\b/i;
const BOILERPLATE_RE = /\b(xstock|backed|backpack|securities|token|tokenized|inc|corp|com|the|and|global|variable|pp)\b/gi;

export type WrapKind = "suffix-x" | "suffix-dash-x" | "suffix-underscore-x" | "prefix-x";

export type PairingMatch = {
  matched: true;
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
  wrapKind: WrapKind;
  wrappedSide: "A" | "B";
  tokenizedEvidence: "both" | "wrapped" | "plain";
  relatedness: "both-tokenized" | "shared-stem" | "plain-is-ticker";
};

export type PairingReject = { matched: false; reason: string };

export type PairingResult = PairingMatch | PairingReject;

export type MintHints = {
  symbol: string;
  name?: string | null;
  extensionsText?: string | null;
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

export function hasTokenizedStockEvidence(name?: string | null, extensionsText?: string | null): boolean {
  return TOKENIZED_RE.test(name || "") || TOKENIZED_RE.test(extensionsText || "");
}

function significantStems(name: string): Set<string> {
  const cleaned = name.replace(BOILERPLATE_RE, " ").toLowerCase();
  const stems = new Set<string>();
  for (const part of cleaned.split(/[^a-z0-9]+/)) {
    if (part.length >= 5) stems.add(part);
  }
  return stems;
}

export function namesShareCompanyStem(wrappedName: string, plainName: string): boolean {
  const wrapped = significantStems(wrappedName);
  const plain = significantStems(plainName);
  for (const a of wrapped) {
    for (const b of plain) {
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

/**
 * Decide whether mint A/B form a same-underlying RWA wrap pair.
 * Pure function — safe for unit tests without network.
 */
export function matchSameAssetPair(mintA: MintHints, mintB: MintHints): PairingResult {
  const symbolA = (mintA.symbol || "").trim();
  const symbolB = (mintB.symbol || "").trim();
  if (!symbolA || !symbolB) return { matched: false, reason: "missing symbol" };
  if (symbolA.toUpperCase() === symbolB.toUpperCase()) {
    return { matched: false, reason: "identical symbols (not wrap vs plain)" };
  }

  const wrapA = parseWrapSymbol(symbolA);
  const wrapB = parseWrapSymbol(symbolB);

  let baseSymbol: string;
  let wrappedSymbol: string;
  let plainSymbol: string;
  let wrapKind: WrapKind;
  let wrappedSide: "A" | "B";
  let wrappedHints: MintHints;
  let plainHints: MintHints;

  if (wrapA && !wrapB && wrapA.base === symbolB.toUpperCase()) {
    baseSymbol = wrapA.base;
    wrappedSymbol = symbolA;
    plainSymbol = symbolB;
    wrapKind = wrapA.kind;
    wrappedSide = "A";
    wrappedHints = mintA;
    plainHints = mintB;
  } else if (wrapB && !wrapA && wrapB.base === symbolA.toUpperCase()) {
    baseSymbol = wrapB.base;
    wrappedSymbol = symbolB;
    plainSymbol = symbolA;
    wrapKind = wrapB.kind;
    wrappedSide = "B";
    wrappedHints = mintB;
    plainHints = mintA;
  } else if (wrapA && wrapB) {
    return { matched: false, reason: "both symbols look wrapped" };
  } else {
    return { matched: false, reason: "symbols are not a FOOx/FOO (or xFOO/FOO) wrap pair" };
  }

  if (STABLECOIN_BASES.has(baseSymbol)) {
    return { matched: false, reason: `stablecoin base ${baseSymbol} excluded` };
  }

  const wrappedTok = hasTokenizedStockEvidence(wrappedHints.name, wrappedHints.extensionsText);
  const plainTok = hasTokenizedStockEvidence(plainHints.name, plainHints.extensionsText);
  if (!wrappedTok && !plainTok) {
    return { matched: false, reason: "no xStock/Backpack/tokenized naming evidence" };
  }

  let relatedness: PairingMatch["relatedness"];
  if (wrappedTok && plainTok) {
    relatedness = "both-tokenized";
  } else if ((plainHints.name || "").trim().toUpperCase() === baseSymbol) {
    relatedness = "plain-is-ticker";
  } else if (namesShareCompanyStem(wrappedHints.name || "", plainHints.name || "")) {
    relatedness = "shared-stem";
  } else {
    return { matched: false, reason: "counterparty name unrelated to tokenized side" };
  }

  return {
    matched: true,
    baseSymbol,
    wrappedSymbol,
    plainSymbol,
    wrapKind,
    wrappedSide,
    tokenizedEvidence: wrappedTok && plainTok ? "both" : wrappedTok ? "wrapped" : "plain",
    relatedness,
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

export function isToken2022Program(programId?: string | null): boolean {
  return (programId || "") === TOKEN_2022_PROGRAM_ID;
}

export function hasFreezeTag(tags?: string[] | null): boolean {
  return Array.isArray(tags) && tags.some((t) => t.toLowerCase() === "hasfreeze");
}
