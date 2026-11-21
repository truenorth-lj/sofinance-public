/**
 * The position performance report as the UI reads it: the `/api/position-performance` body (Raydium) and a registry
 * DEX's `PositionPerformance.report` (`src/lib/dex/adapter.ts`). Protocol-neutral types only, so both the shared DEX
 * contract and the UI can name it without importing a DEX implementation. An adapter's report is type-checked
 * against it where the adapter returns `PositionPerformance`; the `/api/position-performance` JSON is read as-is.
 */
import type { PairGuard, SidePricing } from "@sofinance/engine/valuation/pair-pricing";

type UiSide = { a: number; b: number };

/**
 * USD pricing of a position's two tokens. Multiply raw / 10^decimals by `usdPerRawUnitA/B` (never by a share price):
 * the multiplier is already in it. `guard` is the cross-check against the pool price (null when pricing was skipped).
 */
export type PositionPricingReport<Source extends string = string> = {
  source: Source;
  label: string;
  usdPerRawUnitA: number | null;
  usdPerRawUnitB: number | null;
  sharePriceUsdA: number | null;
  sharePriceUsdB: number | null;
  multiplierA: number | null;
  multiplierB: number | null;
  basis: { a: SidePricing["basis"]; b: SidePricing["basis"] };
  guard: PairGuard | null;
};

type TokenEquivalent = {
  baseSymbol: string;
  baseSide: "A" | "B";
  wrappedSymbol: string | null;
  tickUsed: number;
  uiPriceBPerA: number;
  basis: string;
  note: string;
  metrics: {
    deposited: number;
    equity: number;
    liquidity: number;
    uncollectedFees: number;
    feesEarned: number;
    withdrawnPrincipal: number;
    pnl: number;
    holdingPeriodReturnPct: number | null;
    annualizedReturnPct: number | null;
    feeOnlyAprPct: number | null;
  };
};

type TokenNative = {
  symbolA: string | null;
  symbolB: string | null;
  sameAssetWrap: boolean;
  wrapKind: string | null;
  amounts: {
    deposited: UiSide;
    currentEquity: UiSide;
    feesEarned: UiSide;
    liquidityAmounts: UiSide;
    uncollectedFees: UiSide;
    feesCollected: UiSide;
    withdrawnPrincipal: UiSide;
    pnl: UiSide;
  };
  perSideFeeAprPct: { a: number | null; b: number | null };
  tokenEquivalent: TokenEquivalent | null;
};

type Metrics = {
  holdingDays: number | null;
  depositedUsd: number | null;
  currentEquityUsd: number | null;
  liquidityUsd: number | null;
  uncollectedFeesUsd: number | null;
  feesEarnedUsd: number | null;
  pnlUsd: number | null;
  holdingPeriodReturnPct: number | null;
  annualizedReturnPct: number | null;
  feeOnlyAprPct: number | null;
  depositedRaw: { a: string; b: string };
  currentEquityRaw: { a: string; b: string };
  liquidityAmountsRaw: { a: string; b: string };
  feesEarnedRaw: { a: string; b: string };
  uncollectedFeesRaw: { a: string; b: string };
  feesCollectedRaw: { a: string; b: string };
};

/**
 * The stock view of a same-stock pool position (FOOx/FOO): existing report amounts and per-side USD valuations.
 * The share quote is in the token-equivalent base-side mint, not the more liquid mint's unit. Built by `computeStockPerformance` (`@/lib/stock-performance`); absent for other pools.
 */
export type StockPerformance = {
  /** Plain ticker, e.g. "NVDA". */
  symbol: string;
  /** The token-equivalent base-side mint whose Jupiter quote is displayed. */
  priceMint: string | null;
  /** USD per share (registry price before the pair guard, ÷ the multiplier now). */
  priceUsd: number | null;
  /** Jupiter `priceChange24h` of `priceMint`, percent: rolling 24h of on-chain trading, not a US session. */
  change24hPct: number | null;
  /** Shares in the position now (raw units × the multiplier now): liquidity plus unclaimed fees. */
  sharesNow: number;
  valueUsd: number | null;
  /** Shares put in and still in the position (at the multiplier now): deposits minus withdrawn principal. */
  sharesIn: number | null;
  firstDepositAtIso: string | null;
  /** Recorded deposit-time price per share at the multiplier now (split- and dividend-adjusted); null until recorded. */
  entryPriceUsd: number | null;
  /** sharesIn × (priceUsd − entryPriceUsd), computed in raw units (the same figure). */
  priceChangeUsd: number | null;
  priceChangePct: number | null;
  /** Fees earned since the first deposit (collected plus unclaimed), in shares. */
  feeShares: number;
  feeUsd: number | null;
  /** priceChangeUsd + feeUsd. */
  totalUsd: number | null;
  /** Hourly closes over the last 24h, oldest first (empty when unavailable). */
  sparkline24h: number[];
  /** Daily closes from the first deposit day to today, oldest first, at most 60 points. */
  sparklineSinceEntry: number[];
  /** Where the entry price came from, for the footnote. */
  entryPriceSource: string | null;
  /** Why the entry price is missing, when it is. */
  entryUnavailableReason: string | null;
};

export type PositionPerformanceReport = {
  positionMint: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tickLower?: number;
  tickUpper?: number;
  tickCurrent: number;
  rangeSide: string;
  liquidity: string;
  openedAtIso: string | null;
  evaluatedAtIso: string;
  truncated: boolean;
  signatureCount: number;
  ownsNft: boolean | null;
  cashflows: {
    openCount: number;
    increaseCount: number;
    decreaseCount: number;
  };
  metrics: Metrics;
  tokenNative?: TokenNative;
  /** Same-stock pools only. */
  stock?: StockPerformance | null;
  pricing: PositionPricingReport;
  assumptions: string;
  method: string;
  realizedFeeAprSeries?: {
    label: string;
    assumptions: string;
    points: Array<{ time: number; date: string; aprPct: number | null; kind: string }>;
  };
  historyFetch?: {
    txCount: number;
    elapsedMs: number;
    provider: "default" | "unknown";
    source?: string;
    defaultTxCount?: number;
    fallbackReasons?: string[];
    canContinue?: boolean;
    refreshSignaturesResolved?: boolean;
  };
  error?: string;
};
