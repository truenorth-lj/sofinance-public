import { LandingPage } from "@/components/landing-page";
import { loadHomepagePoolsSnapshot } from "@/lib/homepage-pools-snapshot";
import { loadHomepageStocks } from "@/lib/stock-market/homepage";
import { homeJsonLd, serializeJsonLd } from "@/lib/json-ld";
import { pageMetadata } from "@/lib/seo";

/**
 * ISR: the prerendered homepage (with both chains' pool snapshot and its "Updated … UTC" time in the HTML) is
 * regenerated at most every 15 minutes, on traffic only, from saved snapshots (each chain's list and its pools' 7-day APRs). The
 * client still refreshes the table from the CDN-cached `/api/rwa-pairs` and `/api/protocol-pools` after load.
 */
export const revalidate = 900; // keep equal to HOMEPAGE_POOLS_REVALIDATE_SECONDS

export const metadata = pageMetadata({
  title: "SoFinance: collect trading fees on your tokenized stocks",
  absoluteTitle: true,
  description:
    "Pair two tokens of the same stock, like SPCX/SPCXx, and collect trading fees while price stays in your range. Compare Tight, Standard and Wide ranges. Self-custodial.",
  path: "/",
});

export default async function Home() {
  const [initialPools, initialStocks] = await Promise.all([loadHomepagePoolsSnapshot(), loadHomepageStocks()]);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(homeJsonLd()) }} />
      <LandingPage initialPools={initialPools} initialStocks={initialStocks} />
    </>
  );
}
