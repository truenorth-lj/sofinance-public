"use client";

/**
 * Homepage Top Gainers / Top Stocks (beside the homepage's Top Pools card, passed in as `children`). The page HTML
 * carries the server snapshot (Jupiter search, cached 10 minutes); only when it had none do the cards load once from
 * `/api/stock-market` (`useHomepageStocks`, which the price ticker reads too). A row gets a Buy button only when the
 * server's eligibility check selected an issuer token for it (`buy[underlying]`). A row the check refused (no route,
 * a multiplier other than 1, an unverified non-xStocks issuer) shows a greyed "Not supported yet" with the plain reason
 * as its tooltip, like the pools list. When the check itself failed there is no button at all. The Buy modal (wallet + providers) loads on first click.
 */
import dynamic from "next/dynamic";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { InfoTip } from "@/components/info-tip";
import { TokenIcon } from "@/components/token-icon";
import { NOT_SUPPORTED_LABEL } from "@/lib/unified-pools/model";
import { utcMinuteLabel } from "@/lib/snapshot-updated";
import { formatChangePct, formatCompactUsd, formatStockPrice, STOCK_NOTICE_TEXT } from "@/lib/stock-market/format";
import type { HomepageStocks, StockBuyOption, StockGainerRow, StockMcapRow } from "@/lib/stock-market/public";

const SpotSwapRoot = dynamic(() => import("./spot-swap-root").then((module) => module.SpotSwapRoot), { ssr: false });

const labelPill = "inline-flex min-h-6 shrink-0 items-center whitespace-nowrap rounded-full border border-white/25 px-3 py-1 font-data text-[10px] uppercase leading-4 tracking-[0.12em] text-cream/75";

type Row = (StockGainerRow | StockMcapRow) & { mcapUsd?: number };

/** 24h change, coloured only by direction (the one place the cards use colour besides Buy). */
export function ChangeText({ value, className }: { value: number; className?: string }) {
  return <span className={cn("font-data text-xs", value > 0 ? "text-[#7be0a5]" : value < 0 ? "text-[#ff9a8a]" : "text-smoke", className)}>{formatChangePct(value)}</span>;
}

function StockRow({ row, rank, option, unsupported, onBuy, showMcap }: { row: Row; rank: number; option: StockBuyOption | undefined; unsupported: string | undefined; onBuy: (option: StockBuyOption) => void; showMcap: boolean }) {
  return <li className={marketRow} data-testid={`stock-row-${row.underlying}`}>
    <span className="w-4 shrink-0 font-data text-xs text-smoke">{rank}</span>
    <TokenIcon symbol={row.underlying} icon={row.icon} className="h-8 w-8 text-xs" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-cream">{row.company}</span>
      <span className="block truncate font-data text-[11px] uppercase tracking-[0.08em] text-smoke">
        {row.underlying}{showMcap && row.mcapUsd !== undefined ? ` · ${formatCompactUsd(row.mcapUsd)}` : ""}
      </span>
    </span>
    <span className="shrink-0 text-right">
      <span className="block font-data text-sm text-cream">{formatStockPrice(row.priceUsd)}</span>
      <ChangeText value={row.change24hPct} />
    </span>
    {option ? <button type="button" onClick={() => onBuy(option)} data-testid={`stock-buy-${row.underlying}`}
      aria-label={`Buy ${row.company} with USDC`}
      className="shrink-0 rounded-full bg-lemon px-3 py-2 text-xs font-semibold text-ink outline-none transition-colors hover:bg-[#fff27f] focus-visible:shadow-[0_0_0_2px_var(--color-lilac)]">
      Buy
    </button> : unsupported ? <span data-testid={`stock-unsupported-${row.underlying}`} aria-disabled="true" title={unsupported} className="inline-flex shrink-0 items-center">
      {/* Below 640px: a greyed Buy the same width as the real one, plus an ⓘ with the reason, so the name keeps its room. */}
      <span className="inline-flex items-center gap-1 sm:hidden" data-testid={`stock-unsupported-narrow-${row.underlying}`}>
        <button type="button" disabled aria-label={`Buy ${row.company}: ${unsupported}`}
          className="cursor-not-allowed rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-cream/45">Buy</button>
        <InfoTip label={`Why ${row.company} is not supported yet: ${unsupported}`} tone="dark" placement="below">{unsupported}</InfoTip>
      </span>
      <span className="hidden min-h-8 cursor-not-allowed items-center gap-1 whitespace-nowrap rounded-full border border-white/20 px-3 text-xs font-semibold text-cream/60 sm:inline-flex">
        <span>{NOT_SUPPORTED_LABEL}</span>
        <InfoTip label={`Why ${row.company} is not supported yet: ${unsupported}`} tone="dark" placement="below">{unsupported}</InfoTip>
      </span>
    </span> : null}
  </li>;
}

/**
 * The card frame shared by the homepage's three market cards: title, one-line subtitle, a pill, then the rows.
 * Corners nest from the card in: card 28px with 16px padding → rows panel 12px → rows 8px (the panel's 4px padding).
 */
export function MarketCard({ testId, title, subtitle, pill, className, children }: {
  testId: string; title: string; subtitle: string; pill: string; className?: string; children: ReactNode;
}) {
  return <section data-testid={testId} className={cn("min-w-0 rounded-surface border border-white/12 bg-char p-4 [--radius-inset:0.75rem]", className)}>
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-cream">{title}</h2>
        <p className="mt-1 text-xs text-smoke">{subtitle}</p>
      </div>
      <span className={labelPill}>{pill}</span>
    </div>
    {children}
  </section>;
}

/** The rows' inset panel inside a `MarketCard`. */
export const marketRowsPanel = "mt-3 rounded-inset border border-white/10 bg-black/20 p-1";
/**
 * One row of a market card: the same height in every card, so cards side by side line up row for row. `min-h-16` sets
 * that height; the 8px padding leaves room for the tallest column (a stock's price + 24h change, 44px) inside it.
 */
export const marketRow = "flex min-h-16 items-center gap-2 rounded-lg px-2 py-2 sm:gap-3 sm:px-3";

/**
 * Loading state of a market card: five placeholder rows of the final row height, so the card (and everything below it)
 * keeps its size when the data arrives and the rows simply fill in where the placeholders were.
 */
export function MarketRowsSkeleton({ label }: { label: string }) {
  const bar = "block rounded-full bg-white/[0.07]";
  return <ol className={marketRowsPanel} aria-busy="true" data-testid="market-rows-skeleton">
    <li className="sr-only" role="status">{label}</li>
    {[0, 1, 2, 3, 4].map((index) => <li key={index} aria-hidden="true" className={marketRow}>
      <span className="w-4 shrink-0 font-data text-xs text-smoke/50">{index + 1}</span>
      <span className="h-8 w-8 shrink-0 rounded-full bg-white/[0.07]" />
      <span className="min-w-0 flex-1 space-y-2"><span className={`${bar} h-3 w-28`} /><span className={`${bar} h-2.5 w-16`} /></span>
      <span className="flex shrink-0 flex-col items-end space-y-2"><span className={`${bar} h-3 w-14`} /><span className={`${bar} h-2.5 w-10`} /></span>
    </li>)}
  </ol>;
}

function StockCard({ testId, title, subtitle, pill, rows, buy, unsupported, onBuy, showMcap }: {
  testId: string; title: string; subtitle: string; pill: string; rows: Row[] | null; buy: Record<string, StockBuyOption>; unsupported: Record<string, string>; onBuy: (option: StockBuyOption) => void; showMcap: boolean;
}) {
  return <MarketCard testId={testId} title={title} subtitle={subtitle} pill={pill}>
    {rows === null ? <MarketRowsSkeleton label="Loading stock data…" />
      : rows.length ? <ol className={marketRowsPanel}>
        {rows.map((row, index) => <StockRow key={row.underlying} row={row} rank={index + 1} option={buy[row.underlying]} unsupported={unsupported[row.underlying]} onBuy={onBuy} showMcap={showMcap} />)}
      </ol> : <p className="mt-3 text-sm text-smoke">No stock token meets the liquidity and volume filters right now.</p>}
  </MarketCard>;
}

/**
 * Top Gainers and Top Stocks, then `children` (the homepage's Top Pools card) in the same grid: one column on phones,
 * two from 768px (a third card spans both), three from 1280px (narrower, the rows would cut the names short). Without data the two stock cards say they are loading.
 */
export function StockCardsView({ stocks, onBuy, children }: { stocks: HomepageStocks | null; onBuy: (option: StockBuyOption) => void; children?: ReactNode }) {
  const snapshot = stocks ? utcMinuteLabel(stocks.snapshotAt) : null;
  const buy = stocks?.buy ?? {}, unsupported = stocks?.unsupported ?? {};
  return <div data-testid="stock-cards">
    <div className={cn("grid gap-3 md:grid-cols-2", children && "xl:grid-cols-3")}>
      <StockCard testId="stock-card-gainers" title="Top Gainers" subtitle="Best 24h price performance." pill="24h" rows={stocks?.gainers ?? null} buy={buy} unsupported={unsupported} onBuy={onBuy} showMcap={false} />
      <StockCard testId="stock-card-stocks" title="Top Stocks" subtitle="Largest by Solana onchain market cap." pill="Mkt cap" rows={stocks?.stocks ?? null} buy={buy} unsupported={unsupported} onBuy={onBuy} showMcap />
      {children}
    </div>
    <p data-testid="stock-cards-notice" className="mt-2 px-1 text-[11px] leading-5 text-smoke sm:text-right">
      {STOCK_NOTICE_TEXT}{snapshot ? ` Stock data: Jupiter, snapshot ${snapshot}.` : ""}
    </p>
  </div>;
}

/** The homepage stock data: the server snapshot, else one load from `/api/stock-market` (null until then, or on failure). */
export function useHomepageStocks(initial: HomepageStocks | null): HomepageStocks | null {
  const [stocks, setStocks] = useState<HomepageStocks | null>(initial);
  useEffect(() => {
    if (initial) return;
    const aborter = new AbortController();
    void fetch("/api/stock-market", { signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(25_000)]) })
      .then(async (response) => (response.ok ? await response.json() as HomepageStocks : null))
      .then((value) => { if (value?.snapshotAt) setStocks(value); })
      .catch(() => { /* cards stay in their loading line; nothing else depends on them */ });
    return () => aborter.abort();
  }, [initial]);
  return stocks;
}

/** Ticker rows: the snapshot's `ticker`, or (older snapshots) the cards' stocks, one per stock. */
export function tickerRows(stocks: HomepageStocks | null): StockGainerRow[] {
  if (!stocks) return [];
  if (stocks.ticker?.length) return stocks.ticker;
  const seen = new Set<string>();
  return [...stocks.stocks, ...stocks.gainers].filter((row) => (seen.has(row.underlying) ? false : (seen.add(row.underlying), true)));
}

export function StockCards({ stocks, children }: { stocks: HomepageStocks | null; children?: ReactNode }) {
  const [selected, setSelected] = useState<StockBuyOption | null>(null);
  // Mounted after the first Buy and kept mounted, so the purchase notice (toast) outlives the modal.
  const [rootOpened, setRootOpened] = useState(false);
  const onBuy = (option: StockBuyOption) => { setRootOpened(true); setSelected(option); };
  return <>
    <StockCardsView stocks={stocks} onBuy={onBuy}>{children}</StockCardsView>
    {rootOpened ? <SpotSwapRoot option={selected} onClose={() => setSelected(null)} /> : null}
  </>;
}
