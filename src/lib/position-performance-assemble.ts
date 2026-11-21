import { ASSUMPTIONS_LABEL, PERFORMANCE_METHOD, TOKEN_NATIVE_ASSUMPTIONS, type PositionPerformanceMetrics, type TokenNativeMetrics } from "@sofinance/engine/position-performance-math";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { fetchRaydiumPoolUsdPrices, fetchTokenPricesUsd, type TokenPriceQuote, type TokenPriceSource } from "@sofinance/engine/token-prices";
import { assetKey } from "@sofinance/engine/valuation/asset";
import { pricePair } from "@sofinance/engine/valuation/pair-pricing";
import { multiplierHintsFromQuote } from "@sofinance/engine/valuation/price-sources/token-price-quotes";
import { assetRegistry } from "@sofinance/engine/valuation/registry";
import type { AssetRef, MultiplierHint, ValuationWarning } from "@sofinance/engine/valuation/types";
import { buildStockPerformance } from "./stock-performance-build";
import { buildRealizedFeeAprSeries } from "./realized-fee-apr-series";
import type { HistoryFetchMetric } from "./position-performance-history";
import type { PositionHistoryEvent, PositionPerformanceResult, PositionPricingSource } from "./position-performance";
import type { PositionPricingReport } from "./position-performance-report";

export const DEFAULT_MAX_SIGNATURES = 100;

/** Shared deadline for a performance read (accounts + history + pricing + metadata). */
export const PERFORMANCE_READ_TIMEOUT_MS = 50_000;
/** Hard cap on getSignaturesForAddress / history window size. */
export const MAX_PERFORMANCE_SIGNATURES = 500;

export function capMaxSignatures(maxSignatures?: number, fallback = DEFAULT_MAX_SIGNATURES): number {
  return Math.min(Math.max(1, maxSignatures ?? fallback), MAX_PERFORMANCE_SIGNATURES);
}

const PRICE_SOURCE_ID: Record<TokenPriceSource, Exclude<PositionPricingSource, "none" | "dexscreener+jupiter" | "dexscreener+raydium" | "jupiter+raydium" | "dexscreener+jupiter+raydium">> = {
  jupiter: "jupiter-price-v3",
  dexscreener: "dexscreener",
  raydium: "raydium-pool-stable",
};

const PRICE_SOURCE_LABEL: Record<string, string> = {
  "jupiter-price-v3": "USD uses Jupiter Price API v3 at evaluation time (current), NOT historical tx-time prices.",
  dexscreener: "USD uses DexScreener at evaluation time (current), NOT historical tx-time prices. Jupiter Price API v3 was unavailable.",
  "raydium-pool-stable": "USD from Raydium pool mid price with USDC/USDT ≈ $1 fallback (current), NOT historical tx-time prices.",
};

/** Label the actual sources used; never reports Jupiter alone when a fallback filled a mint. */
export function describePositionPricing(
  quoteA: TokenPriceQuote | undefined,
  quoteB: TokenPriceQuote | undefined,
): { source: PositionPricingSource; label: string } {
  if (!quoteA || !quoteB) {
    return { source: "none", label: "USD pricing did not return both mint prices; USD metrics null." };
  }
  const unique = [...new Set([quoteA.source, quoteB.source])].sort();
  const source = (unique.length === 1 ? PRICE_SOURCE_ID[unique[0]!] : unique.join("+")) as PositionPricingSource;
  const label = PRICE_SOURCE_LABEL[source] ?? `USD from ${unique.join(" and ")} at evaluation time (current), NOT historical tx-time prices.`;
  return { source, label };
}

/** One side of a position to price: the mint, its decimals, and the multiplier hint its reader got in its own batch. */
export type PricingSide = { mint: string; decimals: number; hint: MultiplierHint | null };

export type PositionPricing = PositionPricingReport<PositionPricingSource>;

const UNPRICED: Omit<PositionPricing, "source" | "label"> = {
  usdPerRawUnitA: null, usdPerRawUnitB: null, sharePriceUsdA: null, sharePriceUsdB: null,
  multiplierA: null, multiplierB: null, basis: { a: null, b: null }, guard: null,
};

const logValuation = (record: Record<string, unknown>) => {
  // eslint-disable-next-line no-console -- deliberate marker: a multiplier conflict or a pair-guard correction (PM Q1, X3-3)
  console.warn("[valuation]", JSON.stringify(record));
};

/**
 * USD per raw unit for both sides of a position. Quotes go through the asset registry with the hints the reader already
 * has (mint accounts from its own batch, then Jupiter's `scaledUiConfig`), so a per-share price gets the multiplier and
 * a per-raw price never does; then the pair guard cross-checks them against the pool price. No new RPC calls.
 */
export function pricePosition(input: {
  a: PricingSide;
  b: PricingSide;
  quoteA: TokenPriceQuote | undefined;
  quoteB: TokenPriceQuote | undefined;
  poolPriceBPerA: number | null;
  nowMs: number;
  /** When the quotes were fetched (Jupiter `scaledUiConfig` hints are timestamped with it). */
  quotesObservedAtMs: number;
  /** Identifies the position in logs. */
  logContext?: Record<string, string>;
}): PositionPricing {
  const { a, b, quoteA, quoteB, nowMs } = input;
  const warnings: ValuationWarning[] = [];
  const refA: AssetRef = { chain: "solana", address: a.mint };
  const refB: AssetRef = { chain: "solana", address: b.mint };
  const hintsOf = (side: PricingSide, quote: TokenPriceQuote | undefined) =>
    [...(side.hint ? [side.hint] : []), ...(quote ? multiplierHintsFromQuote(quote, input.quotesObservedAtMs) : [])];
  const assets = assetRegistry.resolve([
    { ref: refA, decimals: a.decimals, hints: hintsOf(a, quoteA) },
    { ref: refB, decimals: b.decimals, hints: hintsOf(b, quoteB) },
  ], { nowMs, warn: (warning) => warnings.push(warning) });
  const priced = pricePair({
    a: { asset: assets.get(assetKey(refA))!, quote: quoteA ? assetRegistry.quoteOf(quoteA) : null },
    b: { asset: assets.get(assetKey(refB))!, quote: quoteB ? assetRegistry.quoteOf(quoteB) : null },
    poolPriceBPerA: input.poolPriceBPerA, nowMs,
  });
  for (const warning of warnings) logValuation({ ...input.logContext, ...warning });
  if (priced.guard.kind === "corrected" || priced.guard.kind === "unresolved") logValuation({ ...input.logContext, kind: "pair-guard", guard: priced.guard });
  return {
    ...describePositionPricing(quoteA, quoteB),
    usdPerRawUnitA: priced.a.usdPerRawUnit, usdPerRawUnitB: priced.b.usdPerRawUnit,
    sharePriceUsdA: priced.a.sharePriceUsd, sharePriceUsdB: priced.b.sharePriceUsd,
    multiplierA: priced.a.multiplier, multiplierB: priced.b.multiplier,
    basis: { a: priced.a.basis, b: priced.b.basis },
    guard: priced.guard,
  };
}

export async function priceAndLabel(input: {
  a: PricingSide;
  b: PricingSide;
  /** Pool price as token B per token A in raw units, from the reader's own pool state; null skips the pair guard. */
  poolPriceBPerA: number | null;
  /** Evaluation time (the position's `evaluatedAt`). */
  nowMs: number;
  skipPricing?: boolean;
  fetcher: typeof fetch;
  jupiterApiKey?: string;
  /** When set, fill a missing mint from the Raydium pool mid / stable-USD fallback (engine helper, fail-soft). */
  raydiumPoolId?: string;
  /** A portfolio read shares one price batch across all positions. */
  quotes?: ReadonlyMap<string, TokenPriceQuote>;
  logContext?: Record<string, string>;
}): Promise<{
  quotes: Map<string, TokenPriceQuote>;
  pricing: PositionPricing;
  pricingMs: number;
}> {
  const pricingStarted = Date.now();
  let pricing: PositionPricing = { source: "none", label: "USD pricing skipped; token-raw / token-native metrics only.", ...UNPRICED };
  let quotes = new Map<string, TokenPriceQuote>();
  const mintA = input.a.mint;
  const mintB = input.b.mint;
  if (!input.skipPricing) {
    try {
      quotes = input.quotes ? new Map(input.quotes) : await fetchTokenPricesUsd([mintA, mintB], input.fetcher, input.jupiterApiKey ?? getJupiterApiKey());
      const quotesObservedAtMs = input.quotes ? input.nowMs : Date.now();
      let quoteA = quotes.get(mintA);
      let quoteB = quotes.get(mintB);
      if (input.raydiumPoolId && (!quoteA || !quoteB)) {
        const fallback = await fetchRaydiumPoolUsdPrices(input.raydiumPoolId, mintA, mintB, input.fetcher);
        const raydium = (mint: string): TokenPriceQuote | undefined => {
          const price = fallback.get(mint);
          return price !== undefined ? { price, source: "raydium", basis: "per-raw-unit" } : undefined;
        };
        quoteA = quoteA ?? raydium(mintA);
        quoteB = quoteB ?? raydium(mintB);
      }
      pricing = pricePosition({ a: input.a, b: input.b, quoteA, quoteB, poolPriceBPerA: input.poolPriceBPerA,
        nowMs: input.nowMs, quotesObservedAtMs, logContext: input.logContext });
    } catch {
      pricing = { source: "none", label: "USD pricing request failed; USD metrics null.", ...UNPRICED };
    }
  }
  return { quotes, pricing, pricingMs: Date.now() - pricingStarted };
}

export async function resolveSymbols(input: {
  mintA: string;
  mintB: string;
  fetcher: typeof fetch;
  jupiterApiKey?: string;
  initialA?: string | null;
  initialB?: string | null;
  /** `prefer`: token metadata overrides the initial symbols (Orca/Meteora). `fill-missing`: only fill empty sides (Raydium). */
  metadata: "prefer" | "fill-missing";
  prefetch?: () => Promise<{ symbolA: string | null; symbolB: string | null }>;
}): Promise<{ symbolA: string | null; symbolB: string | null; metadataMs: number }> {
  const metadataStarted = Date.now();
  let symbolA = input.initialA ?? null;
  let symbolB = input.initialB ?? null;
  if (input.prefetch) {
    try {
      const prefetched = await input.prefetch();
      symbolA = prefetched.symbolA;
      symbolB = prefetched.symbolB;
    } catch { /* ignore */ }
  }
  if (input.metadata === "prefer" || !symbolA || !symbolB) {
    try {
      const meta = await getTokenMetadata([input.mintA, input.mintB], input.fetcher, input.jupiterApiKey ?? getJupiterApiKey());
      if (input.metadata === "prefer") {
        symbolA = meta[input.mintA]?.symbol ?? symbolA;
        symbolB = meta[input.mintB]?.symbol ?? symbolB;
      } else {
        symbolA = symbolA ?? meta[input.mintA]?.symbol ?? null;
        symbolB = symbolB ?? meta[input.mintB]?.symbol ?? null;
      }
    } catch { /* keep initial / prefetched symbols */ }
  }
  return { symbolA, symbolB, metadataMs: Date.now() - metadataStarted };
}

/** Null the same eight return/APR fields when history is incomplete. Mutates in place. */
export function blankIncompleteMetrics(metrics: PositionPerformanceMetrics, tokenNative: TokenNativeMetrics): void {
  metrics.pnlUsd = null;
  metrics.holdingPeriodReturnPct = null;
  metrics.annualizedReturnPct = null;
  metrics.feeOnlyAprPct = null;
  tokenNative.perSideFeeAprPct = { a: null, b: null };
  if (tokenNative.tokenEquivalent) {
    tokenNative.tokenEquivalent.metrics.holdingPeriodReturnPct = null;
    tokenNative.tokenEquivalent.metrics.annualizedReturnPct = null;
    tokenNative.tokenEquivalent.metrics.feeOnlyAprPct = null;
  }
}

export type AssembledIdentity = {
  wallet: string | null;
  ownsNft: boolean | null;
  positionMint: string;
  positionAccount: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  rangeSide: PositionPerformanceResult["rangeSide"];
  liquidity: string;
  openedAt: number | null;
  evaluatedAt: number;
  signatureCount: number;
  truncated: boolean;
  maxSignatures: number;
  history: PositionHistoryEvent[];
  cashflows: PositionPerformanceResult["cashflows"];
};

export async function assemblePerformanceResult(input: {
  identity: AssembledIdentity;
  metrics: PositionPerformanceMetrics;
  tokenNative: TokenNativeMetrics;
  quotes: Map<string, TokenPriceQuote>;
  pricing: PositionPricing;
  incomplete: boolean;
  incompleteMessage: string;
  extraAssumptions?: readonly string[];
  stockIncomplete: boolean;
  skipPricing?: boolean;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  uncollectedFees: { a: bigint; b: bigint };
  historyFetch: HistoryFetchMetric;
  started: number;
  accountsMs: number;
  pricingMs: number;
  metadataStarted: number;
}): Promise<PositionPerformanceResult> {
  if (input.incomplete) blankIncompleteMetrics(input.metrics, input.tokenNative);
  const assumptions = [ASSUMPTIONS_LABEL, TOKEN_NATIVE_ASSUMPTIONS, ...(input.extraAssumptions ?? []),
    ...(input.incomplete ? [input.incompleteMessage] : [])].join(" ");
  const { identity } = input;
  const realizedFeeAprSeries = buildRealizedFeeAprSeries({
    history: identity.history, positionMint: identity.positionMint, poolId: identity.poolId,
    evaluatedAt: identity.evaluatedAt, uncollectedFees: input.uncollectedFees,
    usdPerRawUnitA: input.pricing.usdPerRawUnitA, usdPerRawUnitB: input.pricing.usdPerRawUnitB,
    decimalsA: identity.decimalsA, decimalsB: identity.decimalsB, openedAt: identity.openedAt,
  });
  if (input.incomplete) realizedFeeAprSeries.points = [];
  const stock = input.skipPricing ? null : await buildStockPerformance({
    history: identity.history, positionId: identity.positionMint, poolId: identity.poolId,
    mintA: identity.mintA, mintB: identity.mintB, decimalsA: identity.decimalsA, decimalsB: identity.decimalsB,
    tokenNative: input.tokenNative, metrics: input.metrics, incomplete: input.stockIncomplete,
    quotes: input.quotes, pricing: input.pricing, nowSeconds: identity.evaluatedAt, fetcher: input.fetcher, signal: input.signal,
  });
  return {
    wallet: identity.wallet,
    ownsNft: identity.ownsNft,
    positionMint: identity.positionMint,
    positionAccount: identity.positionAccount,
    poolId: identity.poolId,
    mintA: identity.mintA,
    mintB: identity.mintB,
    decimalsA: identity.decimalsA,
    decimalsB: identity.decimalsB,
    tickLower: identity.tickLower,
    tickUpper: identity.tickUpper,
    tickCurrent: identity.tickCurrent,
    rangeSide: identity.rangeSide,
    liquidity: identity.liquidity,
    openedAt: identity.openedAt,
    openedAtIso: identity.openedAt !== null ? new Date(identity.openedAt * 1000).toISOString() : null,
    evaluatedAt: identity.evaluatedAt,
    evaluatedAtIso: new Date(identity.evaluatedAt * 1000).toISOString(),
    signatureCount: identity.signatureCount,
    truncated: identity.truncated,
    maxSignatures: identity.maxSignatures,
    history: identity.history,
    cashflows: identity.cashflows,
    metrics: input.metrics,
    tokenNative: input.tokenNative,
    stock,
    pricing: input.pricing,
    method: PERFORMANCE_METHOD,
    assumptions,
    realizedFeeAprSeries,
    historyFetch: input.historyFetch,
    timings: { totalMs: Date.now() - input.started, accountsMs: input.accountsMs, historyMs: input.historyFetch.elapsedMs,
      pricingMs: input.pricingMs, metadataMs: Date.now() - input.metadataStarted },
  };
}

