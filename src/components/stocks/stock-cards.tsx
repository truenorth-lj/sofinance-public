"use client";

/**
 * Homepage Top Gainers / Top Stocks. The page HTML carries the server snapshot (Jupiter search, cached 10 minutes);
 * only when it had none do the cards load once from `/api/stock-market`. The server lists only stocks the eligibility
 * check selected an issuer token for (`buy[underlying]`), so every row has a Buy button; a stock we do not support is
 * skipped for the next one in the ranking. When the check itself failed, the rows come without Buy (no button at all).
 * The Buy modal (wallet + providers) loads on first click.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { TokenIcon } from "@/components/token-icon";
import { utcMinuteLabel } from "@/lib/snapshot-updated";
import { formatChangePct, formatCompactUsd, formatStockPrice, STOCK_NOTICE_TEXT } from "@/lib/stock-market/format";
import type { HomepageStocks, StockBuyOption, StockGainerRow, StockMcapRow } from "@/lib/stock-market/public";

const SpotSwapRoot = dynamic(() => import("./spot-swap-root").then((module) => module.SpotSwapRoot), { ssr: false });

const labelPill = "inline-flex min-h-6 items-center rounded-full border border-white/25 px-2.5 py-0.5 font-data text-[10px] uppercase leading-4 tracking-[0.12em] text-cream/75";

type Row = (StockGainerRow | StockMcapRow) & { mcapUsd?: number };

function ChangeText({ value }: { value: number }) {
  return <span className={`font-data text-xs ${value > 0 ? "text-[#7be0a5]" : value < 0 ? "text-[#ff9a8a]" : "text-smoke"}`}>{formatChangePct(value)}</span>;
}

function StockRow({ row, rank, option, onBuy, showMcap }: { row: Row; rank: number; option: StockBuyOption | undefined; onBuy: (option: StockBuyOption) => void; showMcap: boolean }) {
  return <li className="flex items-center gap-2.5 rounded-2xl px-2 py-2.5 sm:gap-3 sm:px-3" data-testid={`stock-row-${row.underlying}`}>
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
      className="shrink-0 rounded-full bg-lemon px-3 py-1.5 text-xs font-semibold text-ink outline-none transition-colors hover:bg-[#fff27f] focus-visible:shadow-[0_0_0_2px_var(--color-lilac)]">
      Buy
    </button> : null}
  </li>;
}

function StockCard({ testId, title, subtitle, pill, rows, buy, onBuy, showMcap }: {
  testId: string; title: string; subtitle: string; pill: string; rows: Row[]; buy: Record<string, StockBuyOption>; onBuy: (option: StockBuyOption) => void; showMcap: boolean;
}) {
  return <section data-testid={testId} className="min-w-0 rounded-[28px] border border-white/12 bg-char p-4 sm:p-5">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-cream">{title}</h2>
        <p className="mt-1 text-xs text-smoke">{subtitle}</p>
      </div>
      <span className={labelPill}>{pill}</span>
    </div>
    {rows.length ? <ol className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-1">
      {rows.map((row, index) => <StockRow key={row.underlying} row={row} rank={index + 1} option={buy[row.underlying]} onBuy={onBuy} showMcap={showMcap} />)}
    </ol> : <p className="mt-3 text-sm text-smoke">No stock token meets the liquidity and volume filters right now.</p>}
  </section>;
}

export function StockCardsView({ stocks, onBuy }: { stocks: HomepageStocks | null; onBuy: (option: StockBuyOption) => void }) {
  const snapshot = stocks ? utcMinuteLabel(stocks.snapshotAt) : null;
  return <div data-testid="stock-cards" className="mt-3">
    {stocks ? <div className="grid gap-3 md:grid-cols-2">
      <StockCard testId="stock-card-gainers" title="Top Gainers" subtitle="Best 24h price performance." pill="24h" rows={stocks.gainers} buy={stocks.buy} onBuy={onBuy} showMcap={false} />
      <StockCard testId="stock-card-stocks" title="Top Stocks" subtitle="Largest by Solana onchain market cap." pill="Mkt cap" rows={stocks.stocks} buy={stocks.buy} onBuy={onBuy} showMcap />
    </div> : <p role="status" className="rounded-[28px] border border-white/12 bg-char p-5 text-sm text-smoke">Loading stock data…</p>}
    <p data-testid="stock-cards-notice" className="mt-2 px-1 text-[11px] leading-5 text-smoke sm:text-right">
      {STOCK_NOTICE_TEXT}{snapshot ? ` Stock data: Jupiter, snapshot ${snapshot}.` : ""}
    </p>
  </div>;
}

export function StockCards({ initial }: { initial: HomepageStocks | null }) {
  const [stocks, setStocks] = useState<HomepageStocks | null>(initial);
  const [selected, setSelected] = useState<StockBuyOption | null>(null);
  // Mounted after the first Buy and kept mounted, so the purchase notice (toast) outlives the modal.
  const [rootOpened, setRootOpened] = useState(false);
  useEffect(() => {
    if (initial) return;
    const aborter = new AbortController();
    void fetch("/api/stock-market", { signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(25_000)]) })
      .then(async (response) => (response.ok ? await response.json() as HomepageStocks : null))
      .then((value) => { if (value?.snapshotAt) setStocks(value); })
      .catch(() => { /* cards stay in their loading line; nothing else depends on them */ });
    return () => aborter.abort();
  }, [initial]);
  const onBuy = (option: StockBuyOption) => { setRootOpened(true); setSelected(option); };
  return <>
    <StockCardsView stocks={stocks} onBuy={onBuy} />
    {rootOpened ? <SpotSwapRoot option={selected} onClose={() => setSelected(null)} /> : null}
  </>;
}
