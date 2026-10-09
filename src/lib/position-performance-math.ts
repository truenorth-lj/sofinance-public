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
  "Returns use on-chain token amounts; USD uses current prices (not tx-time prices) and is secondary.",
  "Same-asset RWA wrap pairs prefer token-equivalent (TE) in the plain/base ticker via current tick mid.",
  "holdingPeriodReturnPct = pnl / deposited × 100 (TE when available; else USD).",
  "annualizedReturnPct = holdingPeriodReturnPct × 365 / holdingDays (simple, not compounded).",
  "feeOnlyAprPct = feesEarned / deposited × 365 / holdingDays × 100 (TE when available; else USD).",
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

/**
 * Token-native / token-equivalent (TE) valuation for same-asset RWA wrap pairs.
 *
 * uiPriceBPerA = 1.0001^tick × 10^(decimalsA − decimalsB)  (UI units of B per 1 UI A)
 * TE in A = amountA_ui + amountB_ui / uiPriceBPerA
 * TE in B = amountA_ui * uiPriceBPerA + amountB_ui
 *
 * Prefer TE in the plain/base ticker for FOOx/FOO pairs. USD stays optional/secondary.
 */

export const TOKEN_NATIVE_ASSUMPTIONS = [
  "Token-native metrics use on-chain raw amounts converted to UI decimals.",
  "Same-asset wrap pairs: TE uses current tick mid (NOT historical): uiPriceBPerA = 1.0001^tickCurrent × 10^(decA−decB).",
  "Prefer TE in the plain/base ticker (not the wrapped side); also expose raw A/B.",
  "holdingPeriodReturnPct_TE = pnl_TE / deposited_TE × 100.",
  "annualizedReturnPct_TE = holdingPeriodReturnPct_TE × 365 / holdingDays (simple).",
  "feeOnlyAprPct_TE = feesEarned_TE / deposited_TE × 365 / holdingDays × 100.",
  "perSideFeeAprPct = feesEarned_side / deposited_side × 365 / holdingDays × 100 (UI amounts).",
  "USD remains optional/secondary (current Jupiter/Raydium prices, not tx-time).",
].join(" ");

export type UiSideAmounts = { a: number; b: number };

export type TokenNativeCashflowUi = {
  deposited: UiSideAmounts;
  withdrawnPrincipal: UiSideAmounts;
  feesCollected: UiSideAmounts;
  uncollectedFees: UiSideAmounts;
  feesEarned: UiSideAmounts;
  liquidityAmounts: UiSideAmounts;
  currentEquity: UiSideAmounts;
  pnl: UiSideAmounts;
};

export type TokenEquivalentSnapshot = {
  deposited: number;
  withdrawnPrincipal: number;
  feesCollected: number;
  uncollectedFees: number;
  feesEarned: number;
  liquidity: number;
  equity: number;
  pnl: number;
  holdingPeriodReturnPct: number | null;
  annualizedReturnPct: number | null;
  feeOnlyAprPct: number | null;
};

export type TokenEquivalentBundle = {
  /** Plain/base ticker when wrap pair; otherwise the TE unit symbol. */
  baseSymbol: string;
  baseSide: "A" | "B";
  wrappedSymbol: string | null;
  tickUsed: number;
  uiPriceBPerA: number;
  basis: string;
  note: string;
  metrics: TokenEquivalentSnapshot;
};

export type TokenNativeMetrics = {
  symbolA: string | null;
  symbolB: string | null;
  sameAssetWrap: boolean;
  wrapKind: string | null;
  amounts: TokenNativeCashflowUi;
  perSideFeeAprPct: { a: number | null; b: number | null };
  /** Preferred TE in base token when same-asset wrap; null otherwise. */
  tokenEquivalent: TokenEquivalentBundle | null;
};

export function rawToUiAmount(raw: bigint, decimals: number): number {
  return rawToUi(raw, decimals);
}

export function sidesToUi(
  amounts: TokenSideAmounts,
  decimalsA: number,
  decimalsB: number,
): UiSideAmounts {
  return { a: rawToUi(amounts.a, decimalsA), b: rawToUi(amounts.b, decimalsB) };
}

/**
 * UI price of token A quoted in token B (how many B per 1 A), from CLMM tick.
 * Matches Raydium pool mid: 1.0001^tick × 10^(decimalsA − decimalsB).
 */
export function uiPriceBPerAFromTick(tick: number, decimalsA: number, decimalsB: number): number {
  if (!Number.isFinite(tick) || !Number.isInteger(tick)) {
    throw new Error("tick must be a finite integer");
  }
  if (!Number.isInteger(decimalsA) || !Number.isInteger(decimalsB) || decimalsA < 0 || decimalsB < 0) {
    throw new Error("Invalid token decimals");
  }
  const price = Math.pow(1.0001, tick) * Math.pow(10, decimalsA - decimalsB);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("tick mid price is not a positive finite number");
  }
  return price;
}

/** Convert A+B UI amounts into a single TE value in the chosen base side. */
export function toTokenEquivalentUi(
  amounts: UiSideAmounts,
  uiPriceBPerA: number,
  baseSide: "A" | "B",
): number {
  if (!Number.isFinite(uiPriceBPerA) || uiPriceBPerA <= 0) {
    throw new Error("uiPriceBPerA must be positive");
  }
  if (baseSide === "A") return amounts.a + amounts.b / uiPriceBPerA;
  return amounts.a * uiPriceBPerA + amounts.b;
}

export function feeAprFromRatio(fees: number, deposited: number, holdingDays: number | null): number | null {
  if (holdingDays === null || !(holdingDays > 0) || !(deposited > 0) || !Number.isFinite(fees) || !Number.isFinite(deposited)) {
    return null;
  }
  return (fees / deposited) * (365 / holdingDays) * 100;
}

export function computeTokenEquivalentSnapshot(
  amounts: TokenNativeCashflowUi,
  uiPriceBPerA: number,
  baseSide: "A" | "B",
  holdingDays: number | null,
): TokenEquivalentSnapshot {
  const te = (s: UiSideAmounts) => toTokenEquivalentUi(s, uiPriceBPerA, baseSide);
  const deposited = te(amounts.deposited);
  const withdrawnPrincipal = te(amounts.withdrawnPrincipal);
  const feesCollected = te(amounts.feesCollected);
  const uncollectedFees = te(amounts.uncollectedFees);
  const feesEarned = te(amounts.feesEarned);
  const liquidity = te(amounts.liquidityAmounts);
  const equity = te(amounts.currentEquity);
  // Prefer recompute pnl from TE legs to avoid floating drift vs side-wise TE of pnlRaw
  const pnl = equity + withdrawnPrincipal + feesCollected - deposited;
  const holdingPeriodReturnPct = deposited > 0 && Number.isFinite(pnl) ? (pnl / deposited) * 100 : null;
  const annualizedReturnPct = annualizeSimplePct(holdingPeriodReturnPct, holdingDays);
  const feeOnlyAprPct = feeAprFromRatio(feesEarned, deposited, holdingDays);
  return {
    deposited,
    withdrawnPrincipal,
    feesCollected,
    uncollectedFees,
    feesEarned,
    liquidity,
    equity,
    pnl,
    holdingPeriodReturnPct,
    annualizedReturnPct,
    feeOnlyAprPct,
  };
}

export type ComputeTokenNativeInput = {
  deposited: TokenSideAmounts;
  withdrawnPrincipal: TokenSideAmounts;
  feesCollected: TokenSideAmounts;
  liquidityAmounts: TokenSideAmounts;
  uncollectedFees: TokenSideAmounts;
  holdingDays: number | null;
  decimalsA: number;
  decimalsB: number;
  tickCurrent: number;
  symbolA?: string | null;
  symbolB?: string | null;
  /** When true (FOOx/FOO wrap), prefer TE in plain/base side. */
  sameAssetWrap: boolean;
  wrapKind?: string | null;
  /** Which pool side is the wrapped token; plain/base is the other. Required when sameAssetWrap. */
  wrappedSide?: "A" | "B" | null;
  plainSymbol?: string | null;
  wrappedSymbol?: string | null;
};

export function computeTokenNativeMetrics(input: ComputeTokenNativeInput): TokenNativeMetrics {
  const currentEquity = addSides(input.liquidityAmounts, input.uncollectedFees);
  const feesEarned = addSides(input.feesCollected, input.uncollectedFees);
  const totalReturned = addSides(input.withdrawnPrincipal, input.feesCollected);
  const pnlRaw = subSides(addSides(currentEquity, totalReturned), input.deposited);

  const amounts: TokenNativeCashflowUi = {
    deposited: sidesToUi(input.deposited, input.decimalsA, input.decimalsB),
    withdrawnPrincipal: sidesToUi(input.withdrawnPrincipal, input.decimalsA, input.decimalsB),
    feesCollected: sidesToUi(input.feesCollected, input.decimalsA, input.decimalsB),
    uncollectedFees: sidesToUi(input.uncollectedFees, input.decimalsA, input.decimalsB),
    feesEarned: sidesToUi(feesEarned, input.decimalsA, input.decimalsB),
    liquidityAmounts: sidesToUi(input.liquidityAmounts, input.decimalsA, input.decimalsB),
    currentEquity: sidesToUi(currentEquity, input.decimalsA, input.decimalsB),
    pnl: sidesToUi(pnlRaw, input.decimalsA, input.decimalsB),
  };

  const perSideFeeAprPct = {
    a: feeAprFromRatio(amounts.feesEarned.a, amounts.deposited.a, input.holdingDays),
    b: feeAprFromRatio(amounts.feesEarned.b, amounts.deposited.b, input.holdingDays),
  };

  let tokenEquivalent: TokenEquivalentBundle | null = null;
  if (input.sameAssetWrap && (input.wrappedSide === "A" || input.wrappedSide === "B")) {
    const baseSide: "A" | "B" = input.wrappedSide === "A" ? "B" : "A";
    const uiPriceBPerA = uiPriceBPerAFromTick(input.tickCurrent, input.decimalsA, input.decimalsB);
    const baseSymbol =
      (input.plainSymbol && input.plainSymbol.trim()) ||
      (baseSide === "A" ? input.symbolA : input.symbolB) ||
      (baseSide === "A" ? "A" : "B");
    const wrappedSymbol =
      (input.wrappedSymbol && input.wrappedSymbol.trim()) ||
      (input.wrappedSide === "A" ? input.symbolA : input.symbolB) ||
      null;
    tokenEquivalent = {
      baseSymbol,
      baseSide,
      wrappedSymbol,
      tickUsed: input.tickCurrent,
      uiPriceBPerA,
      basis: `token-equivalent in ${baseSymbol} using current tick mid (NOT historical)`,
      note: `Same-asset RWA pool; TE converts ${wrappedSymbol ?? "wrap"}→${baseSymbol} via 1.0001^tickCurrent × 10^(decA−decB)`,
      metrics: computeTokenEquivalentSnapshot(amounts, uiPriceBPerA, baseSide, input.holdingDays),
    };
  }

  return {
    symbolA: input.symbolA ?? null,
    symbolB: input.symbolB ?? null,
    sameAssetWrap: input.sameAssetWrap,
    wrapKind: input.wrapKind ?? null,
    amounts,
    perSideFeeAprPct,
    tokenEquivalent,
  };
}
