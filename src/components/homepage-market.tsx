"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { TOP_POOLS_ANCHOR_ID } from "@/lib/homepage-pools";
import { DOCS_ROUTES, GUIDE_ROUTES } from "@/lib/public-urls";
import type { HomepageStocks } from "@/lib/stock-market/public";
import { StockCards, useHomepageStocks } from "./stocks/stock-cards";
import { HomepageTopPools, useHomepagePools } from "./homepage-pools-table";

export const HERO_H1 = "Hold the stock. Collect the fees.";
export const HERO_SUBLINE =
  "Put two tokens of the same stock, like TSLAx and TSLA, in one pool. Traders swap between them, and you collect a share of the swap fees.";
export const HERO_SEE_POOLS = "See pools";
export const HERO_HOW_IT_WORKS = "How it works";
export const HERO_TRUST = [
  { text: "Self-custodial: we never hold your keys", href: DOCS_ROUTES.security },
  { text: "Zero performance fee. 0.10% only when we swap.", href: GUIDE_ROUTES.fees },
  { text: "Solana + Robinhood Chain", href: DOCS_ROUTES.home },
] as const;

const primaryBtn =
  "inline-flex h-12 items-center justify-center rounded-full bg-lemon px-6 text-sm font-semibold text-ink outline-none transition-colors hover:bg-[#fff27f] focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]";
const secondaryBtn =
  "inline-flex h-12 items-center justify-center rounded-full border border-white/30 px-6 text-sm font-semibold text-cream outline-none transition-colors hover:border-cream focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]";

/**
 * The homepage between the header and the footer: the hero, the top-5 pools block, then Top Gainers / Top Stocks.
 */
export function HomepageMarketView({ initialPools = null, initialStocks = null }: {
  initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null;
}) {
  const stocks = useHomepageStocks(initialStocks);
  const pools = useHomepagePools(initialPools);

  return <>
    <div className="mx-auto max-w-[1280px] px-3 sm:px-5">
      <section data-testid="landing-hero" className="relative isolate px-1 pb-10 pt-12 text-center sm:pb-14 sm:pt-20">
        <h1 className="mx-auto max-w-[20ch] text-[clamp(2.2rem,5.6vw,4.4rem)] font-medium leading-[1.02] tracking-[-0.045em] text-cream">
          Hold the stock. <span className="text-lemon">Collect the fees.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-3xl text-balance text-base leading-7 text-cream/70 sm:text-lg">
          {HERO_SUBLINE}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href={`#${TOP_POOLS_ANCHOR_ID}`} className={primaryBtn} data-testid="hero-see-pools">{HERO_SEE_POOLS}</a>
          <Link href={GUIDE_ROUTES.whatIsSameStock} className={secondaryBtn} data-testid="hero-how-it-works">{HERO_HOW_IT_WORKS}</Link>
        </div>
        <ul data-testid="hero-trust" className="mx-auto mt-8 flex max-w-3xl flex-col items-center gap-2 text-sm leading-6 text-smoke sm:gap-3">
          {HERO_TRUST.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="underline decoration-white/25 underline-offset-4 transition-colors hover:text-cream hover:decoration-cream">
                {item.text}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <HomepageTopPools data={pools} />

      <StockCards stocks={stocks} />
    </div>
  </>;
}

/** Renders the view (client-only: inside the landing page's Suspense). */
export function HomepageMarket(props: { initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null }) {
  // Kept so this tree still suspends on `useSearchParams` (the landing page's prerendered fallback is HomepageMarketView).
  useSearchParams();
  return <HomepageMarketView {...props} />;
}
