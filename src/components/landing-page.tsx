import { Suspense } from "react";
import { HomepageMarket, HomepageMarketView } from "@/components/homepage-market";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { publicPoolDetailHrefs } from "@/lib/public-pool-pages";
import type { HomepageStocks } from "@/lib/stock-market/public";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * The homepage, laid out like a market page: header, the hero, the top-5 pools block, then Top Gainers / Top Stocks.
 * How it works, risks and agents live in Docs, Learn, the FAQ and the app.
 */
export function LandingPage({ initialPools = null, initialStocks = null }: { initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null } = {}) {
  const detailHrefs = publicPoolDetailHrefs(initialPools);
  return (
    <div className="continuous-corners min-h-screen overflow-x-clip bg-canvas text-cream">
      <div className="mx-auto max-w-[1280px] px-3 pt-3 sm:px-5 sm:pt-5">
        <SiteHeader />
      </div>

      <main id="main">
        {/* The fallback is what prerendered HTML contains (useSearchParams bails out to the client), so it renders
            the server snapshots: crawlers see stock and pool names and stats, not loading lines. */}
        <Suspense fallback={<HomepageMarketView initialPools={initialPools} initialStocks={initialStocks} detailHrefs={detailHrefs} />}>
          <HomepageMarket initialPools={initialPools} initialStocks={initialStocks} detailHrefs={detailHrefs} />
        </Suspense>
      </main>

      <div className="mx-auto max-w-[1280px] px-3 pb-10 sm:px-5">
        <SiteFooter variant="marketing" />
      </div>
    </div>
  );
}
