/**
 * The position performance report as the UI reads it: the `/api/position-performance` body (Raydium) and a registry
 * DEX's `PositionPerformance.report` (`src/lib/dex/adapter.ts`). Protocol-neutral types only, so both the shared DEX
 * contract and the UI can name it without importing a DEX implementation. An adapter's report is type-checked
 * against it where the adapter returns `PositionPerformance`; the `/api/position-performance` JSON is read as-is.
 */
type UiSide = { a: number; b: number };

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
  pricing: { source: string; label: string; priceUsdA: number | null; priceUsdB: number | null };
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
