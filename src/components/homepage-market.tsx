"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { APP_ROUTES } from "@/lib/public-urls";
import type { HomepageStocks, StockGainerRow } from "@/lib/stock-market/public";
import { TokenIcon } from "./token-icon";
import { StockCards, useHomepageStocks } from "./stocks/stock-cards";
import { HomepageTopPools, PoolSearchInput, useHomepagePools } from "./homepage-pools-table";

const labelPill =
  "inline-flex min-h-6 max-w-full items-center rounded-full border border-white/25 px-3 py-1 font-data text-[10px] uppercase leading-4 tracking-[0.1em] text-cream/75 sm:whitespace-nowrap sm:tracking-[0.14em]";

/** The stocks the cards show, one per stock (Top Stocks first): the logos behind the hero. */
function shownStocks(stocks: HomepageStocks | null): StockGainerRow[] {
  if (!stocks) return [];
  const seen = new Set<string>();
  return [...stocks.stocks, ...stocks.gainers].filter((row) => (seen.has(row.underlying) ? false : (seen.add(row.underlying), true)));
}

/** Faint stock logos behind the hero (decoration only; hidden below 768px). */
function IconBackdrop({ rows }: { rows: StockGainerRow[] }) {
  const icons = rows.filter((row) => row.icon).slice(0, 16);
  if (icons.length < 8) return null;
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 hidden md:block [mask-image:radial-gradient(ellipse_at_center,transparent_30%,black_75%)]">
    <div className="grid h-full grid-cols-8 grid-rows-2 place-items-center gap-y-6 py-10 opacity-[0.09] grayscale">
      {icons.map((row) => <TokenIcon key={row.underlying} symbol={row.underlying} icon={row.icon} className="h-12 w-12 text-sm" />)}
    </div>
  </div>;
}

/** Where the hero search goes, carrying the typed query as `?q=` so /app/rwa-pairs can prefill its search. */
export function rwaPairsSearchHref(query: string): string {
  const q = query.trim();
  return q ? `${APP_ROUTES.rwaPairs}?q=${encodeURIComponent(q)}` : APP_ROUTES.rwaPairs;
}

/**
 * The homepage between the header and the footer: the hero (headline, search), Top Gainers / Top Stocks,
 * then the single top-5 pools block. Submitting the hero search goes to /app/rwa-pairs with `?q=`.
 */
export function HomepageMarketView({ initialPools = null, initialStocks = null }: {
  initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null;
}) {
  const router = useRouter();
  const stocks = useHomepageStocks(initialStocks);
  const pools = useHomepagePools(initialPools);
  const [query, setQuery] = useState("");
  const backdrop = useMemo(() => shownStocks(stocks), [stocks]);

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    router.push(rwaPairsSearchHref(query));
  };

  return <>
    <div className="mx-auto max-w-[1280px] px-3 sm:px-5">
      <section data-testid="landing-hero" className="relative isolate px-1 pb-10 pt-12 text-center sm:pb-14 sm:pt-20">
        <IconBackdrop rows={backdrop} />
        <span className={labelPill}>Self-custodial · Solana + Robinhood Chain</span>
        <h1 className="mx-auto mt-5 max-w-[20ch] text-[clamp(2.2rem,5.6vw,4.4rem)] font-medium leading-[1.02] tracking-[-0.045em] text-cream">
          Hold your stocks. <span className="text-lemon">Collect fees.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-3xl text-balance text-base leading-7 text-cream/70 sm:text-lg">
          Pair two tokens of the same stock in one pool and collect a share of the swap fees.
        </p>
        <form role="search" action={APP_ROUTES.rwaPairs} method="get" onSubmit={onSearch} className="mx-auto mt-8 max-w-2xl">
          <PoolSearchInput id="hero-search" name="q" query={query} onQueryChange={setQuery} placeholder="Search SPCX, TSLA, AAPL…"
            className="h-14 rounded-full bg-char/80 px-5 backdrop-blur sm:h-16" inputClassName="text-base sm:text-lg" />
        </form>
        <p className="mt-3 h-10 overflow-hidden font-data text-[11px] uppercase leading-5 sm:h-5 tracking-[0.12em] text-smoke">
          <span className="inline-block">0 keys on our servers · verifiable on Solscan and Blockscout</span>
        </p>
      </section>

      <StockCards stocks={stocks} />

      <HomepageTopPools data={pools} />
    </div>
  </>;
}

/** Reads the `?pool=` tweet deep link, then renders the view (client-only: inside the landing page's Suspense). */
export function HomepageMarket(props: { initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null }) {
  // Kept so this tree still suspends on `useSearchParams` (the landing page's prerendered fallback is HomepageMarketView).
  useSearchParams();
  return <HomepageMarketView {...props} />;
}
