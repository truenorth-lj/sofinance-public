"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDown } from "lucide-react";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import type { HomepageStocks, StockGainerRow } from "@/lib/stock-market/public";
import { DEFAULT_SORT } from "@/lib/unified-pools/model";
import { TokenIcon } from "./token-icon";
import { StockCards, useHomepageStocks } from "./stocks/stock-cards";
import { HomepagePoolsList, homepageListRows, PoolSearchInput, TopPoolsCard, useHomepagePools } from "./homepage-pools-table";

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

/**
 * The homepage between the header and the footer: the hero (headline, search), Top Gainers / Top Stocks / Top Pools,
 * then every pool. The hero's search and the list's search are one query that filters the list.
 */
export function HomepageMarketView({ initialPools = null, initialStocks = null, highlightPool }: {
  initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null; highlightPool?: string;
}) {
  const stocks = useHomepageStocks(initialStocks);
  const pools = useHomepagePools(initialPools);
  const [query, setQuery] = useState("");
  // The hint under the search only animates once someone has typed (never on page load).
  const [typed, setTyped] = useState(false);
  const onQueryChange = (value: string) => { setTyped(true); setQuery(value); };
  const backdrop = useMemo(() => shownStocks(stocks), [stocks]);
  const trimmed = query.trim();
  const matches = useMemo(() => (trimmed ? homepageListRows(pools, trimmed, DEFAULT_SORT).pools.length : 0), [pools, trimmed]);
  const hint = trimmed && pools.pools ? "matches" : "trust";

  /**
   * Scrolls to the list and hands the cursor to the list's search box (same query, caret at the end), so typing
   * carries on in the field the eye just followed instead of in the hero field that scrolled away.
   */
  const showPools = (event?: FormEvent) => {
    event?.preventDefault();
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("pools")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const field = document.getElementById("pools-search");
    if (field instanceof HTMLInputElement) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
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
        <form role="search" onSubmit={showPools} className="mx-auto mt-8 max-w-2xl">
          <PoolSearchInput id="hero-search" query={query} onQueryChange={onQueryChange} placeholder="Search SPCX, TSLA, AAPL…"
            className="h-14 rounded-full bg-char/80 px-5 backdrop-blur sm:h-16" inputClassName="text-base sm:text-lg" />
        </form>
        {/* Fixed height: the line under the search swaps without moving the cards below. The match count grows out of
            the search field (from above); the trust line comes back the same way. The count updates in place. */}
        <p className="mt-3 h-10 overflow-hidden font-data text-[11px] uppercase leading-5 sm:h-5 tracking-[0.12em] text-smoke" aria-live="polite">
          <span key={hint} className={typed ? "inline-block motion-safe:animate-emerge" : "inline-block"}>
            {hint === "matches"
              ? <button type="button" onClick={() => showPools()} className="inline-flex items-center gap-2 text-cream/80 hover:text-cream" data-testid="hero-search-matches">
                <span className="tabular-nums">{matches}</span> {matches === 1 ? "pool matches" : "pools match"} · show <ArrowDown className="h-3 w-3" aria-hidden="true" />
              </button>
              : "0 keys on our servers · verifiable on Solscan and Blockscout"}
          </span>
        </p>
      </section>

      <StockCards stocks={stocks}>
        <TopPoolsCard data={pools} className="md:col-span-2 xl:col-span-1" />
      </StockCards>

      <HomepagePoolsList data={pools} query={query} onQueryChange={onQueryChange} highlightPool={highlightPool} />
    </div>
  </>;
}

/** Reads the `?pool=` tweet deep link, then renders the view (client-only: inside the landing page's Suspense). */
export function HomepageMarket(props: { initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null }) {
  const highlightPool = useSearchParams().get("pool") ?? undefined;
  return <HomepageMarketView {...props} highlightPool={highlightPool} />;
}
