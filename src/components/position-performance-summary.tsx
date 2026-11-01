"use client";

/**
 * The Performance results body shared by the Raydium panel (`position-performance-panel.tsx`) and the registry panel
 * (`unified-positions/registry-performance.tsx`): the stats grid, its notes, the position assets block and the pool daily
 * APR chart with the position's realized fee APR overlaid. Both read the same report shape (`PerformanceResponse`, the
 * `/api/position-performance` body, which a registry DEX returns as `PositionPerformance.report`).
 */
import { PositionAssetRow } from "./position-asset-row";
import { PoolDailyAprChart } from "./pool-daily-apr-panel";
import { formatHoldingTime, returnUnavailableReason } from "../lib/position-performance-display";

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

export type PerformanceResponse = {
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

export const pct = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
};

export const money = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(4)}`;
};

const tok = (value: number | null | undefined, digits = 6) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toPrecision(digits);
};

type AssetMetadata = Record<string, { icon?: string | null } | undefined>;

export function PerformanceSummary({ data, embedded, metadata, loadingRemaining = false, onLoadRemaining }: {
  data: PerformanceResponse;
  /** Embedded in My positions: the position assets block is already drawn above, so it is left out here. */
  embedded: boolean;
  metadata: AssetMetadata;
  loadingRemaining?: boolean;
  /** Re-read with more history when the first read was cut short; omitted = no button. */
  onLoadRemaining?: () => void;
}) {
  const tn = data.tokenNative;
  const te = tn?.tokenEquivalent ?? null;
  const symA = tn?.symbolA ?? "A";
  const symB = tn?.symbolB ?? "B";
  const preferTe = Boolean(te);
  const holdingTime = formatHoldingTime(data.metrics.holdingDays);
  const hasRecordedDeposits = Number(data.metrics.depositedRaw.a) > 0 || Number(data.metrics.depositedRaw.b) > 0;
  const missingReturn = (needsHoldingTime: boolean) => returnUnavailableReason({
    deposited: te ? te.metrics.deposited : data.metrics.depositedUsd ?? null,
    holdingDays: data.metrics.holdingDays ?? null,
    needsHoldingTime,
    missingUsdPrice: !te && (data.pricing.priceUsdA === null || data.pricing.priceUsdB === null),
    truncated: data.truncated ?? false,
  });
  return (
        <div className="space-y-5 text-sm" aria-live="polite">
          {!hasRecordedDeposits && <p role="status" className="rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-xs leading-5 text-cream/80">No deposit history was found. Current inventory is available, but trading-fee APR needs opening or deposit records.</p>}
          {te && <p className="text-xs leading-5 text-smoke">Amounts shown in {te.baseSymbol} equivalent.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={holdingTime.label} value={holdingTime.value} description="Time since the earliest recorded position event." />
            <Stat label="Range" value={data.rangeSide === "inside" ? "In range" : data.rangeSide === "above" ? "Above range" : data.rangeSide === "below" ? "Below range" : data.rangeSide} />
            {preferTe ? (
              <>
                <Stat
                  label="Est. trading-fee APR · not guaranteed"
                  value={pct(te!.metrics.feeOnlyAprPct)}
                  description="Estimate: fees earned so far, annualized. Not a forecast or a promised return."
                  unavailableReason={missingReturn(true)}
                  emphasize
                  wide
                />
                <Stat
                  label={`Fees earned`}
                  value={`${tok(te!.metrics.feesEarned)} ${te!.baseSymbol}`}
                  description={`${data.metrics.feesEarnedUsd !== null ? `${money(data.metrics.feesEarnedUsd)} USD at current prices · ` : ""}Collected plus unclaimed fees.`}
                />
                <Stat
                  label={`Current position value (${te!.baseSymbol} equivalent)`}
                  value={`${tok(te!.metrics.equity)} ${te!.baseSymbol}`}
                  description={`${data.metrics.currentEquityUsd !== null ? `${money(data.metrics.currentEquityUsd)} USD · ` : ""}Liquidity ${tok(te!.metrics.liquidity)} + unclaimed fees ${tok(te!.metrics.uncollectedFees)} ${te!.baseSymbol}.`}
                />
              </>
            ) : (
              <>
                <Stat label="Est. fee-only APR (USD) · not guaranteed" value={pct(data.metrics.feeOnlyAprPct)} description="Estimate: fees earned so far, annualized. Not a forecast or a promised return." unavailableReason={missingReturn(true)} emphasize wide />
                <Stat label="Current equity (USD)" value={money(data.metrics.currentEquityUsd)}
                  description={data.metrics.liquidityUsd !== null && data.metrics.uncollectedFeesUsd !== null ? `Liquidity ${money(data.metrics.liquidityUsd)} + unclaimed fees ${money(data.metrics.uncollectedFeesUsd)}.` : "Liquidity plus unclaimed fees."} />
                <Stat label="Fees earned (USD)" value={money(data.metrics.feesEarnedUsd)} description="Collected plus unclaimed fees." />
              </>
            )}
          </div>

          <p className="text-xs leading-5 text-smoke">
            Estimated APR annualizes the trading fees earned so far (collected plus unclaimed) over recorded deposits and holding time, at current prices. Additional deposits are not time-weighted, and future fees can be higher or lower: it is not a promised return.
            {data.truncated && " Earlier transactions may be missing, so the estimate may be incomplete."}
          </p>
          {data.truncated && data.historyFetch?.canContinue && onLoadRemaining && (
            <button type="button" disabled={loadingRemaining} onClick={onLoadRemaining}
              className="rounded-xl border border-white/20 px-3 py-2 text-xs text-cream disabled:opacity-50">
              {loadingRemaining ? "Loading history…" : "Load remaining history"}
            </button>
          )}

          {!embedded && tn && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-smoke">Position assets</h4>
              <div className="mt-4 divide-y divide-white/10">
                <PositionAssetRow symbol={symA} icon={metadata[data.mintA]?.icon ?? null} decimals={data.decimalsA}
                  liquidityRaw={data.metrics.liquidityAmountsRaw.a} unclaimedFeesRaw={data.metrics.uncollectedFeesRaw.a} priceUsd={data.pricing.priceUsdA} />
                <PositionAssetRow symbol={symB} icon={metadata[data.mintB]?.icon ?? null} decimals={data.decimalsB}
                  liquidityRaw={data.metrics.liquidityAmountsRaw.b} unclaimedFeesRaw={data.metrics.uncollectedFeesRaw.b} priceUsd={data.pricing.priceUsdB} />
              </div>
            </div>
          )}

        </div>
  );
}

/** The pool's daily fee APR chart with this position's realized fee APR overlaid (when a report is loaded). */
export function PerformancePoolChart({ poolId, data }: { poolId: string; data: PerformanceResponse | null }) {
  return (
        <div className="mt-6">
          <PoolDailyAprChart
            poolId={poolId}
            nowSeconds={
              data?.evaluatedAtIso
                ? Math.floor(new Date(data.evaluatedAtIso).getTime() / 1000) || undefined
                : undefined
            }
            overlay={
              data?.realizedFeeAprSeries
                ? {
                    label: data.realizedFeeAprSeries.label,
                    assumptions: data.realizedFeeAprSeries.assumptions,
                    points: data.realizedFeeAprSeries.points.map((point) => ({
                      time: point.time,
                      date: point.date,
                      value: point.aprPct,
                    })),
                  }
                : undefined
            }
          />
        </div>
  );
}

function Stat({ label, value, emphasize, wide, description, unavailableReason }: {
  label: string;
  value: string;
  emphasize?: boolean;
  /** Span both columns of the two-column grid so an odd card count leaves no hole. */
  wide?: boolean;
  description?: string;
  unavailableReason?: string;
}) {
  return (
    <div
      className={`rounded-2xl border px-3 py-2 ${wide ? "sm:col-span-2" : ""} ${
        emphasize ? "border-white/20 bg-white/[0.07]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-smoke">{label}</div>
      <div className={`mt-1 font-semibold ${emphasize ? "text-cream" : "text-cream/90"}`}>{value}</div>
      {description && <p className="mt-1 text-[11px] leading-4 text-smoke">{description}</p>}
      {value === "—" && unavailableReason && <p className="mt-2 text-[11px] leading-4 text-smoke">{unavailableReason}</p>}
    </div>
  );
}

