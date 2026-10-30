import { LandingPage } from "@/components/landing-page";
import { loadHomepagePoolsSnapshot } from "@/lib/homepage-pools-snapshot";
import { homeJsonLd, serializeJsonLd } from "@/lib/json-ld";
import { pageMetadata } from "@/lib/seo";

/**
 * ISR: the prerendered homepage (with both chains' pool snapshot and its "Updated … UTC" time in the HTML) is
 * regenerated at most every 15 minutes, on traffic only, with one saved-snapshot read per chain each time. The
 * client still refreshes the table from the CDN-cached `/api/rwa-pairs` and `/api/protocol-pools` after load.
 */
export const revalidate = 900; // keep equal to HOMEPAGE_POOLS_REVALIDATE_SECONDS

export const metadata = pageMetadata({
  title: "SoFinance: collect trading fees on your tokenized stocks",
  absoluteTitle: true,
  description:
    "Pair two tokens of the same stock, like SPCX/SPCXx, and collect trading fees. See the estimated fee APR first, plus a 7-day backtested range on Solana. Self-custodial.",
  path: "/",
});

export default async function Home() {
  const initialPools = await loadHomepagePoolsSnapshot();
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(homeJsonLd()) }} />
      <LandingPage initialPools={initialPools} />
    </>
  );
}
