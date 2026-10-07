/**
 * Pure math for Raydium CLMM position holding-period / fee APR metrics.
 *
 * All USD inputs are assumed to already use a labeled price basis (typically
 * current Jupiter mid prices). Token amounts stay in raw integer units.
 */

export const PERFORMANCE_METHOD = [
  "Discover txs via getSignaturesForAddress(personalPosition PDA).",
  "Parse Raydium Anchor events from tx logs: CreatePersonalPositionEvent,",
  "IncreaseLiquidityEvent, DecreaseLiquidityEvent (exact deposit/withdraw/fee amounts).",
  "Current equity = LiquidityMath amounts for position L + uncollected fees",
  "(feeGrowth inside − lastInside) × L / Q64 + tokenFeesOwed (same as compound-state).",
  "USD optional via Jupiter Price API v3 (fallback: Raydium pool mid × stable) at evaluation time (NOT historical).",
].join(" ");

export const ASSUMPTIONS_LABEL = [
  "Returns use on-chain token amounts; USD uses current prices (not tx-time prices).",
  "holdingPeriodReturnPct = pnlUsd / depositedUsd × 100.",
  "annualizedReturnPct = holdingPeriodReturnPct × 365 / holdingDays (simple, not compounded).",
  "feeOnlyAprPct = feesEarnedUsd / depositedUsd × 365 / holdingDays × 100.",
  "PnL includes IL, price drift, and fees — not Raydium pool 24h feeApr.",
  "History capped by maxSignatures; truncated=true means earlier txs may be missing.",
].join(" ");

export type TokenSideAmounts = { a: bigint; b: bigint };

export type CashflowTotals = {
  deposited: TokenSideAmounts;
  withdrawnPrincipal: TokenSideAmounts;
  feesCollected: TokenSideAmounts;
};

export type PositionPerformanceInputs = {
  deposited: TokenSideAmounts;
  withdrawnPrincipal: TokenSideAmounts;
  feesCollected: TokenSideAmounts;
  /** Token amounts locked in current liquidity (not including uncollected fees). */
  liquidityAmounts: TokenSideAmounts;
  uncollectedFees: TokenSideAmounts;
  /** Seconds since first open (or increase) event; must be > 0 for annualization. */
  holdingSeconds: number;
  /** Optional USD prices in dollars per whole token (not raw). */
  priceUsdA?: number | null;
  priceUsdB?: number | null;
  decimalsA: number;
  decimalsB: number;
};

export type PositionPerformanceMetrics = {
  holdingDays: number | null;
  depositedRaw: { a: string; b: string };
  withdrawnPrincipalRaw: { a: string; b: string };
  feesCollectedRaw: { a: string; b: string };
  uncollectedFeesRaw: { a: string; b: string };
  liquidityAmountsRaw: { a: string; b: string };
  currentEquityRaw: { a: string; b: string };
  /** feesCollected + uncollectedFees */
  feesEarnedRaw: { a: string; b: string };
  /** equity + withdrawnPrincipal + feesCollected − deposited (per side, raw) */
  pnlRaw: { a: string; b: string };
  priceUsdA: number | null;
  priceUsdB: number | null;
  depositedUsd: number | null;
  withdrawnPrincipalUsd: number | null;
  feesCollectedUsd: number | null;
  uncollectedFeesUsd: number | null;
  feesEarnedUsd: number | null;
  liquidityUsd: number | null;
  currentEquityUsd: number | null;
  /** (equity + all withdrawals including fees) − deposits, at current prices */
  pnlUsd: number | null;
  holdingPeriodReturnPct: number | null;
  annualizedReturnPct: number | null;
  feeOnlyAprPct: number | null;
  method: string;
  assumptions: string;
};

function rawToUi(raw: bigint, decimals: number): number {
  if (decimals < 0 || decimals > 18) throw new Error("Invalid token decimals");
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const value = Number(whole) + Number(frac) / Number(base);
  return neg ? -value : value;
}

export function sideUsd(
  amounts: TokenSideAmounts,
  decimalsA: number,
  decimalsB: number,
  priceUsdA: number | null | undefined,
  priceUsdB: number | null | undefined,
): number | null {
  if (
    priceUsdA === null ||
    priceUsdA === undefined ||
    priceUsdB === null ||
    priceUsdB === undefined ||
    !Number.isFinite(priceUsdA) ||
    !Number.isFinite(priceUsdB) ||
    priceUsdA < 0 ||
    priceUsdB < 0
  ) {
    return null;
  }
  return rawToUi(amounts.a, decimalsA) * priceUsdA + rawToUi(amounts.b, decimalsB) * priceUsdB;
}

export function addSides(x: TokenSideAmounts, y: TokenSideAmounts): TokenSideAmounts {
  return { a: x.a + y.a, b: x.b + y.b };
}

export function subSides(x: TokenSideAmounts, y: TokenSideAmounts): TokenSideAmounts {
  return { a: x.a - y.a, b: x.b - y.b };
}

/**
 * Simple annualization: ratePct × 365 / days.
 * Returns null when days is not positive or rate is null.
 */
export function annualizeSimplePct(ratePct: number | null, holdingDays: number | null): number | null {
  if (ratePct === null || holdingDays === null || !(holdingDays > 0) || !Number.isFinite(ratePct)) {
    return null;
  }
  return (ratePct * 365) / holdingDays;
}

export function holdingDaysFromSeconds(holdingSeconds: number): number | null {
  if (!Number.isFinite(holdingSeconds) || holdingSeconds <= 0) return null;
  return holdingSeconds / 86_400;
}

export function computePositionPerformance(input: PositionPerformanceInputs): PositionPerformanceMetrics {
  const currentEquity = addSides(input.liquidityAmounts, input.uncollectedFees);
  const feesEarned = addSides(input.feesCollected, input.uncollectedFees);
  const totalReturned = addSides(input.withdrawnPrincipal, input.feesCollected);
  const pnlRaw = subSides(addSides(currentEquity, totalReturned), input.deposited);

  const holdingDays = holdingDaysFromSeconds(input.holdingSeconds);
  const priceUsdA = input.priceUsdA ?? null;
  const priceUsdB = input.priceUsdB ?? null;

  const depositedUsd = sideUsd(input.deposited, input.decimalsA, input.decimalsB, priceUsdA, priceUsdB);
  const withdrawnPrincipalUsd = sideUsd(
    input.withdrawnPrincipal,
    input.decimalsA,
    input.decimalsB,
    priceUsdA,
    priceUsdB,
  );
  const feesCollectedUsd = sideUsd(input.feesCollected, input.decimalsA, input.decimalsB, priceUsdA, priceUsdB);
  const uncollectedFeesUsd = sideUsd(input.uncollectedFees, input.decimalsA, input.decimalsB, priceUsdA, priceUsdB);
  const feesEarnedUsd = sideUsd(feesEarned, input.decimalsA, input.decimalsB, priceUsdA, priceUsdB);
  const liquidityUsd = sideUsd(input.liquidityAmounts, input.decimalsA, input.decimalsB, priceUsdA, priceUsdB);
  const currentEquityUsd = sideUsd(currentEquity, input.decimalsA, input.decimalsB, priceUsdA, priceUsdB);
  const pnlUsd =
    depositedUsd === null || currentEquityUsd === null || withdrawnPrincipalUsd === null || feesCollectedUsd === null
      ? null
      : currentEquityUsd + withdrawnPrincipalUsd + feesCollectedUsd - depositedUsd;

  const holdingPeriodReturnPct =
    depositedUsd !== null && depositedUsd > 0 && pnlUsd !== null ? (pnlUsd / depositedUsd) * 100 : null;
  const annualizedReturnPct = annualizeSimplePct(holdingPeriodReturnPct, holdingDays);
  const feeOnlyAprPct =
    depositedUsd !== null && depositedUsd > 0 && feesEarnedUsd !== null && holdingDays !== null && holdingDays > 0
      ? (feesEarnedUsd / depositedUsd) * (365 / holdingDays) * 100
      : null;

  const raw = (s: TokenSideAmounts) => ({ a: s.a.toString(), b: s.b.toString() });

  return {
    holdingDays,
    depositedRaw: raw(input.deposited),
    withdrawnPrincipalRaw: raw(input.withdrawnPrincipal),
    feesCollectedRaw: raw(input.feesCollected),
    uncollectedFeesRaw: raw(input.uncollectedFees),
    liquidityAmountsRaw: raw(input.liquidityAmounts),
    currentEquityRaw: raw(currentEquity),
    feesEarnedRaw: raw(feesEarned),
    pnlRaw: raw(pnlRaw),
    priceUsdA,
    priceUsdB,
    depositedUsd,
    withdrawnPrincipalUsd,
    feesCollectedUsd,
    uncollectedFeesUsd,
    feesEarnedUsd,
    liquidityUsd,
    currentEquityUsd,
    pnlUsd,
    holdingPeriodReturnPct,
    annualizedReturnPct,
    feeOnlyAprPct,
    method: PERFORMANCE_METHOD,
    assumptions: ASSUMPTIONS_LABEL,
  };
}
