import { ASSUMPTIONS_LABEL, PERFORMANCE_METHOD, TOKEN_NATIVE_ASSUMPTIONS, type PositionPerformanceMetrics, type TokenNativeMetrics } from "@sofinance/engine/position-performance-math";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { fetchRaydiumPoolUsdPrices, fetchTokenPricesUsd, type TokenPriceQuote, type TokenPriceSource } from "@sofinance/engine/token-prices";
import { buildStockPerformance } from "./stock-performance-build";
import { buildRealizedFeeAprSeries } from "./realized-fee-apr-series";
import type { HistoryFetchMetric } from "./position-performance-history";
import type { PositionHistoryEvent, PositionPerformanceResult, PositionPricingSource } from "./position-performance";

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
): { source: PositionPricingSource; label: string; priceUsdA: number | null; priceUsdB: number | null } {
  const priceUsdA = quoteA?.price ?? null;
  const priceUsdB = quoteB?.price ?? null;
  if (!quoteA || !quoteB) {
    return { source: "none", label: "USD pricing did not return both mint prices; USD metrics null.", priceUsdA, priceUsdB };
  }
  const unique = [...new Set([quoteA.source, quoteB.source])].sort();
  const source = (unique.length === 1 ? PRICE_SOURCE_ID[unique[0]!] : unique.join("+")) as PositionPricingSource;
  const label = PRICE_SOURCE_LABEL[source] ?? `USD from ${unique.join(" and ")} at evaluation time (current), NOT historical tx-time prices.`;
  return { source, label, priceUsdA, priceUsdB };
}

export async function priceAndLabel(input: {
  mintA: string;
  mintB: string;
  skipPricing?: boolean;
  fetcher: typeof fetch;
  jupiterApiKey?: string;
  /** When set, fill a missing mint from the Raydium pool mid / stable-USD fallback (engine helper, fail-soft). */
  raydiumPoolId?: string;
}): Promise<{
  quotes: Map<string, TokenPriceQuote>;
  priceUsdA: number | null;
  priceUsdB: number | null;
  pricingSource: PositionPricingSource;
  pricingLabel: string;
  pricingMs: number;
}> {
  let priceUsdA: number | null = null;
  let priceUsdB: number | null = null;
  let pricingSource: PositionPricingSource = "none";
  let pricingLabel = "USD pricing skipped; token-raw / token-native metrics only.";
  const pricingStarted = Date.now();
  let quotes = new Map<string, TokenPriceQuote>();
  if (!input.skipPricing) {
    try {
      quotes = await fetchTokenPricesUsd([input.mintA, input.mintB], input.fetcher, input.jupiterApiKey ?? getJupiterApiKey());
      let quoteA = quotes.get(input.mintA);
      let quoteB = quotes.get(input.mintB);
      if (input.raydiumPoolId && (!quoteA || !quoteB)) {
        const fallback = await fetchRaydiumPoolUsdPrices(input.raydiumPoolId, input.mintA, input.mintB, input.fetcher);
        const raydium = (mint: string): TokenPriceQuote | undefined => {
          const price = fallback.get(mint);
          return price !== undefined ? { price, source: "raydium" } : undefined;
        };
        quoteA = quoteA ?? raydium(input.mintA);
        quoteB = quoteB ?? raydium(input.mintB);
      }
      const described = describePositionPricing(quoteA, quoteB);
      priceUsdA = described.priceUsdA;
      priceUsdB = described.priceUsdB;
      pricingSource = described.source;
      pricingLabel = described.label;
    } catch {
      pricingLabel = "USD pricing request failed; USD metrics null.";
    }
  }
  return { quotes, priceUsdA, priceUsdB, pricingSource, pricingLabel, pricingMs: Date.now() - pricingStarted };
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
  pricing: { source: PositionPricingSource; label: string; priceUsdA: number | null; priceUsdB: number | null };
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
    priceUsdA: input.pricing.priceUsdA, priceUsdB: input.pricing.priceUsdB,
    decimalsA: identity.decimalsA, decimalsB: identity.decimalsB, openedAt: identity.openedAt,
  });
  if (input.incomplete) realizedFeeAprSeries.points = [];
  const stock = input.skipPricing ? null : await buildStockPerformance({
    history: identity.history, positionId: identity.positionMint, poolId: identity.poolId,
    mintA: identity.mintA, mintB: identity.mintB, decimalsA: identity.decimalsA, decimalsB: identity.decimalsB,
    tokenNative: input.tokenNative, metrics: input.metrics, incomplete: input.stockIncomplete,
    quotes: input.quotes, nowSeconds: identity.evaluatedAt, fetcher: input.fetcher, signal: input.signal,
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

