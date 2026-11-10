"use client";

/**
 * The Performance results body shared by the Raydium panel (`position-performance-panel.tsx`) and the registry panel
 * (`unified-positions/registry-performance.tsx`): the stats grid, its notes, the position assets block and the pool daily
 * APR chart with the position's realized fee APR overlaid. Both read the same report shape (`PerformanceResponse`, the
 * `/api/position-performance` body, which a registry DEX returns as `PositionPerformance.report`).
 */
import { PositionAssetRow } from "./position-asset-row";
import { PoolDailyAprChart } from "./pool-daily-apr-panel";
import { StockPerformanceTiles } from "./stock-performance-tiles";
import { formatHoldingTime, returnUnavailableReason } from "../lib/position-performance-display";
import type { PositionPerformanceReport } from "../lib/position-performance-report";

/** The report shape both panels draw (see `@/lib/position-performance-report`). */
export type PerformanceResponse = PositionPerformanceReport;

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

export function PerformanceSummary({ data, embedded, metadata, showStockPerformance = true, loadingRemaining = false, onLoadRemaining }: {
  data: PerformanceResponse;
  /** False when the selected position is already represented by the stock overview. */
  showStockPerformance?: boolean;
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
  const stock = data.stock ?? null;
  return (
        <div className="space-y-5 text-sm" aria-live="polite">
          {!showStockPerformance && <dl data-testid="position-detail-identity" className="grid gap-3 rounded-xl border border-white/10 p-3 text-xs sm:grid-cols-2">
            <div className="min-w-0"><dt className="text-smoke">Position</dt><dd className="mt-1 break-all text-cream">{data.positionMint}</dd></div>
            <div className="min-w-0"><dt className="text-smoke">Pool</dt><dd className="mt-1 break-all text-cream">{data.poolId}</dd></div>
          </dl>}
          {stock && showStockPerformance && <StockPerformanceTiles stock={stock} pairLabel={tn?.symbolA && tn?.symbolB ? `${tn.symbolA} / ${tn.symbolB}` : null} />}
          {!hasRecordedDeposits && <p role="status" className="rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-xs leading-5 text-cream/80">No deposit history was found. Current inventory is available, but trading-fee APR needs opening or deposit records.</p>}
          {te && <p className="text-xs leading-5 text-smoke">Amounts shown in {te.baseSymbol} equivalent.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={holdingTime.label} value={holdingTime.value} description="Time since the earliest recorded position event." />
            {/* Embedded in My positions, the range badge above the tabs already says this. */}
            {!embedded && <Stat label="Range" value={data.rangeSide === "inside" ? "In range" : data.rangeSide === "above" ? "Above range" : data.rangeSide === "below" ? "Below range" : data.rangeSide} />}
            {preferTe ? (
              <>
                <Stat
                  label="Est. trading-fee APR · not a prediction"
                  value={pct(te!.metrics.feeOnlyAprPct)}
                  description="Estimate: fees accrued so far, annualized. Not a forecast or a promised return."
                  unavailableReason={missingReturn(true)}
                  emphasize
                  wide={!embedded}
                />
                {!stock && <Stat
                  label={`Fees accrued`}
                  value={`${tok(te!.metrics.feesEarned)} ${te!.baseSymbol}`}
                  description={`${data.metrics.feesEarnedUsd !== null ? `${money(data.metrics.feesEarnedUsd)} USD at current prices · ` : ""}Collected plus unclaimed fees.`}
                />}
                {!stock && <Stat
                  label={`Current position value (${te!.baseSymbol} equivalent)`}
                  value={`${tok(te!.metrics.equity)} ${te!.baseSymbol}`}
                  description={`${data.metrics.currentEquityUsd !== null ? `${money(data.metrics.currentEquityUsd)} USD · ` : ""}Liquidity ${tok(te!.metrics.liquidity)} + unclaimed fees ${tok(te!.metrics.uncollectedFees)} ${te!.baseSymbol}.`}
                />}
              </>
            ) : (
              <>
                <Stat label="Est. fee-only APR (USD) · not a prediction" value={pct(data.metrics.feeOnlyAprPct)} description="Estimate: fees accrued so far, annualized. Not a forecast or a promised return." unavailableReason={missingReturn(true)} emphasize wide={!embedded} />
                <Stat label="Current equity (USD)" value={money(data.metrics.currentEquityUsd)}
                  description={data.metrics.liquidityUsd !== null && data.metrics.uncollectedFeesUsd !== null ? `Liquidity ${money(data.metrics.liquidityUsd)} + unclaimed fees ${money(data.metrics.uncollectedFeesUsd)}.` : "Liquidity plus unclaimed fees."} />
                <Stat label="Fees accrued (USD)" value={money(data.metrics.feesEarnedUsd)} description="Collected plus unclaimed fees." />
              </>
            )}
          </div>

          <p className="text-xs leading-5 text-smoke">
            Estimated APR annualizes the trading fees accrued so far (collected plus unclaimed) over recorded deposits and holding time, at current prices. Additional deposits are not time-weighted, and future fees can be higher or lower: it is not a promised return. Compounded fees count as new deposits, so after a compound this APR reads slightly low.
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

