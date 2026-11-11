"use client";

/**
 * The Performance stock view: three tiles (the stock's price and 24h change, what the shares put in did since they
 * were put in, what the fees added) and the total row. Only up/down is coloured (mint / coral); labels stay on one line.
 * `StockTile`, `StockTotalRow` and `Sparkline` are shared with the all-stocks overview.
 */
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { StockPerformance } from "@/lib/position-performance-report";
import { changeTone, formatChangePct, formatShares, formatShortDate, formatUsd } from "@/lib/stock-performance-format";

const toneClass = { up: "text-mint", down: "text-coral", flat: "text-smoke" } as const;

function Sparkline({ values, className }: { values: readonly number[]; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, i) => `${(i / (values.length - 1) * 56).toFixed(1)},${(2 + (1 - (value - min) / span) * 20).toFixed(1)}`).join(" ");
  const tone = changeTone(values[values.length - 1]! - values[0]!, 1e6);
  return <svg width="56" height="24" viewBox="0 0 56 24" aria-hidden="true" className={cn("shrink-0", toneClass[tone], className)} data-testid="stock-sparkline">
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

export function StockTile({ label, value, sparkline, change, changeTone: tone = "flat", aside, note, testId }: {
  label: string;
  value: string;
  sparkline?: readonly number[];
  change?: ReactNode;
  changeTone?: "up" | "down" | "flat";
  /** Grey text at the right of the change line. */
  aside?: ReactNode;
  /** Shown under the tile when the value is missing. */
  note?: ReactNode;
  testId?: string;
}) {
  return <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] px-5 pb-[18px] pt-5" data-testid={testId}>
    <div className="truncate whitespace-nowrap text-[13px] leading-5 tracking-[0.02em] text-smoke" title={label}>{label}</div>
    <div className="mt-3.5 flex min-h-8 items-center justify-between gap-3">
      <span className="whitespace-nowrap text-2xl font-medium tabular-nums leading-tight tracking-[0.01em] text-cream">{value}</span>
      {sparkline && <Sparkline values={sparkline} />}
    </div>
    {(change || aside) && <div className="mt-3 flex items-baseline justify-between gap-2.5 whitespace-nowrap text-[13px] tabular-nums tracking-[0.02em]">
      <span className={toneClass[tone]}>{change}</span>
      {aside && <span className="truncate text-smoke">{aside}</span>}
    </div>}
    {note && <p className="mt-3 text-[12px] leading-5 text-smoke">{note}</p>}
  </div>;
}

export function StockTotalRow({ priceUsd, feeUsd, totalUsd }: { priceUsd: number | null; feeUsd: number | null; totalUsd: number | null }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 rounded-xl border border-white/10 px-5 py-4" data-testid="stock-total">
    <span className="whitespace-nowrap text-[13px] tracking-[0.02em] text-smoke">Total since deposit</span>
    <span className="whitespace-nowrap text-[13px] tabular-nums tracking-[0.02em]">
      <span className="mr-3 text-smoke">{totalUsd === null ? "Entry price unavailable" : <>price {formatUsd(priceUsd, { signed: true })} + fees {formatUsd(feeUsd)}</>}</span>
      <span className={cn("text-base font-medium", toneClass[changeTone(totalUsd)])}>{formatUsd(totalUsd, { signed: true })}</span>
    </span>
  </div>;
}

/** One position's stock view (the Performance results of a same-stock pool position). */
export function StockPerformanceTiles({ stock, pairLabel, showHeader = true, showFootnote = true }: {
  stock: StockPerformance;
  pairLabel?: string | null;
  /** The overview's expanded row already names the stock and its value. */
  showHeader?: boolean;
  showFootnote?: boolean;
}) {
  const unavailableReasonId = useId();
  const since = formatShortDate(stock.firstDepositAtIso);
  const sharesLabel = stock.sharesIn !== null && since ? `${formatShares(stock.sharesIn)} shares since ${since}` : "Price change since deposit";
  return <section aria-label={`${stock.symbol} performance`} className="space-y-3" data-testid="stock-performance">
    {showHeader && <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <div className="text-base font-medium text-cream">{stock.symbol}
        {pairLabel && <span className="ml-2 text-[13px] font-normal tracking-[0.02em] text-smoke">{pairLabel}</span>}</div>
      <div className="whitespace-nowrap text-[13px] tabular-nums tracking-[0.02em] text-smoke">Position value
        <span className="ml-1.5 font-medium text-cream">{formatUsd(stock.valueUsd)}</span>
        <span className="ml-1.5">· {formatShares(stock.sharesNow)} shares</span></div>
    </div>}
    <div className="grid gap-3 sm:grid-cols-3">
      <StockTile testId="stock-tile-price" label={`${stock.symbol} price`} value={formatUsd(stock.priceUsd)} sparkline={stock.sparkline24h}
        change={formatChangePct(stock.change24hPct)} changeTone={changeTone(stock.change24hPct)} aside="24h" />
      <StockTile testId="stock-tile-shares" label={sharesLabel} value={formatUsd(stock.priceChangeUsd, { signed: true })} sparkline={stock.sparklineSinceEntry}
        change={stock.priceChangePct !== null ? formatChangePct(stock.priceChangePct) : undefined} changeTone={changeTone(stock.priceChangePct)}
        aside={stock.entryPriceUsd !== null ? `from ${formatUsd(stock.entryPriceUsd)}` : undefined}
        note={stock.priceChangeUsd === null ? <>
          <span aria-describedby={unavailableReasonId}>{stock.entryPriceUsd === null ? "Entry price unavailable" : "Price change unavailable"}</span>
          <span id={unavailableReasonId} className="sr-only">{stock.entryUnavailableReason ?? (stock.entryPriceUsd === null
            ? "Entry price is unavailable for this position." : "Price change since deposit is unavailable for this position.")}</span>
        </> : null} />
      <StockTile testId="stock-tile-fees" label="Earned from fees" value={formatUsd(stock.feeUsd)}
        change={`${stock.feeShares > 0 ? "↑ " : ""}${formatShares(stock.feeShares)} ${stock.symbol}`} changeTone={stock.feeShares > 0 ? "up" : "flat"} />
    </div>
    <StockTotalRow priceUsd={stock.priceChangeUsd} feeUsd={stock.feeUsd} totalUsd={stock.totalUsd} />
    {showFootnote && <StockFootnote />}
  </section>;
}

export function StockFootnote() {
  return <p className="text-[11px] leading-relaxed text-smoke" data-testid="stock-footnote">
    24h is rolling token-price change, not a US market session. USD at current prices.
    Collected plus unclaimed fees; do not add them to position value. Missing entry prices and dependent totals show —.
  </p>;
}
