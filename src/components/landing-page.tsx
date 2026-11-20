import { Suspense } from "react";
import { HomepageMarket, HomepageMarketView } from "@/components/homepage-market";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import type { HomepageStocks } from "@/lib/stock-market/public";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * The homepage, laid out like a market page: header, the hero (headline and pool search), Top Gainers / Top Stocks,
 * then the top-5 pools block. How it works, risks and agents live in Docs, the FAQ and the app.
 */
export function LandingPage({ initialPools = null, initialStocks = null }: { initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null } = {}) {
  return (
    <div className="continuous-corners min-h-screen overflow-x-clip bg-canvas text-cream">
      <div className="mx-auto max-w-[1280px] px-3 pt-3 sm:px-5 sm:pt-5">
        <SiteHeader variant="marketing" />
      </div>

      <main>
        {/* The fallback is what prerendered HTML contains (useSearchParams bails out to the client), so it renders
            the server snapshots: crawlers see stock and pool names and stats, not loading lines. */}
        <Suspense fallback={<HomepageMarketView initialPools={initialPools} initialStocks={initialStocks} />}>
          <HomepageMarket initialPools={initialPools} initialStocks={initialStocks} />
        </Suspense>
      </main>

      <div className="mx-auto max-w-[1280px] px-3 pb-10 sm:px-5">
        <SiteFooter variant="marketing" />
      </div>
    </div>
  );
}
