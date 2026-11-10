import Link from "next/link";
import { Suspense } from "react";
import { HomepageMarket, HomepageMarketView } from "@/components/homepage-market";
import { HomepageWalletIsland } from "@/components/homepage-wallet-island";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import type { HomepageStocks } from "@/lib/stock-market/public";
import { APP_ROUTES, BLOG_ROUTES, DOCS_ROUTES, FAQ_ROUTE, LEGAL_ROUTES, LLMS_TXT_ROUTE } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS, SOCIAL_LINKS } from "@/lib/social-links";
import { XIcon } from "@/components/x-icon";
import { SiteHeader } from "@/components/site-header";

/**
 * The homepage, laid out like a market page: header, the hero (headline and pool search), Top Gainers / Top Stocks /
 * Top Pools, then every pool. How it works, risks and agents live in Docs, the FAQ and the app.
 */
export function LandingPage({ initialPools = null, initialStocks = null }: { initialPools?: HomepagePoolsSnapshot | null; initialStocks?: HomepageStocks | null } = {}) {
  return (
    <div className="continuous-corners min-h-screen overflow-x-clip bg-canvas text-cream">
      <div className="mx-auto max-w-[1280px] px-3 pt-3 sm:px-5 sm:pt-5">
        <SiteHeader onHomepage />
      </div>

      <main>
        {/* The fallback is what prerendered HTML contains (useSearchParams bails out to the client), so it renders
            the server snapshots: crawlers see stock and pool names and stats, not loading lines. */}
        <Suspense fallback={<HomepageMarketView initialPools={initialPools} initialStocks={initialStocks} />}>
          <HomepageMarket initialPools={initialPools} initialStocks={initialStocks} />
        </Suspense>
      </main>
      {/* The page's one wallet (header Connect wallet + Buy), outside the Suspense boundary so it is mounted once. */}
      <HomepageWalletIsland />

      <div className="mx-auto max-w-[1280px] px-3 pb-10 sm:px-5">
        <footer className="mt-10 flex flex-col gap-4 border-t border-white/10 px-1 py-6 font-data text-[11px] uppercase tracking-[0.12em] text-smoke sm:flex-row sm:items-center sm:justify-between">
          <p>SoFinance · Self-custodial liquidity on Solana and Robinhood Chain</p>
          <div className="flex flex-wrap items-center gap-5">
            <Link href={APP_ROUTES.home} className="transition-colors hover:text-cream">
              App
            </Link>
            <Link href={APP_ROUTES.ai} className="transition-colors hover:text-cream">
              AI agents
            </Link>
            <Link href={BLOG_ROUTES.home} className="transition-colors hover:text-cream">
              Blog
            </Link>
            <Link href={DOCS_ROUTES.home} className="transition-colors hover:text-cream">
              Docs
            </Link>
            <Link href={FAQ_ROUTE} className="transition-colors hover:text-cream">
              FAQ
            </Link>
            <Link href={DOCS_ROUTES.risks} className="transition-colors hover:text-cream">
              Risks
            </Link>
            <Link href={LEGAL_ROUTES.terms} className="transition-colors hover:text-cream">
              Terms
            </Link>
            <a href={LLMS_TXT_ROUTE} className="transition-colors hover:text-cream" title="Plain-text summary for AI assistants">
              llms.txt
            </a>
            <a
              href={SOCIAL_LINKS.x.href}
              {...EXTERNAL_LINK_PROPS}
              aria-label={SOCIAL_LINKS.x.ariaLabel}
              className="inline-flex items-center gap-2 transition-colors hover:text-cream"
            >
              <XIcon className="h-3 w-3" />
              {SOCIAL_LINKS.x.label}
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
