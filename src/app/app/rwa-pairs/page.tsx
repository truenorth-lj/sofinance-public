import { HideOnMount } from "@/components/hide-on-mount";
import { PublicPoolsTable } from "@/components/public-pools-table";
import { PoolsPage } from "@/components/unified-pools/pools-page";
import { loadHomepagePoolsSnapshot } from "@/lib/homepage-pools-snapshot";
import { serializeJsonLd } from "@/lib/json-ld";
import { publicPoolsItemListJsonLd } from "@/lib/public-pools-table";
import { parseCalcParam, parseOpenPoolParam, firstQueryValue } from "@/lib/public-urls";
import { unifiedPoolFlags } from "@/lib/unified-pools/flags";

/**
 * Same window as the homepage snapshot cache. The region-notice cookie in proxy may still keep the document
 * `private, no-store`; the table itself is built from that cached snapshot, with no per-request RPC.
 */
export const revalidate = 900;

/**
 * The pools page: Solana + Robinhood Chain pools in one list. `?openPool=<id>` opens that pool (where `/app/rhc` and old
 * `/app?openPool=` links are redirected). `?calc=<id>` opens the share calculator. Legacy open links still parse.
 * `?q=` prefills the list search (the homepage hero search submits here).
 */
export default async function RwaPairsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const deepLinkPool = parseOpenPoolParam(query);
  const deepLinkCalc = parseCalcParam(query);
  const initialQuery = firstQueryValue(query.q);
  const { rhcSigning, ...flags } = unifiedPoolFlags();
  const snapshot = await loadHomepagePoolsSnapshot();
  const itemList = publicPoolsItemListJsonLd(snapshot);
  return (
    <>
      {itemList && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(itemList) }}
        />
      )}
      <HideOnMount>
        <PublicPoolsTable snapshot={snapshot} />
      </HideOnMount>
      <PoolsPage flags={flags} rhcSigningEnabled={rhcSigning} deepLinkPool={deepLinkPool || undefined} deepLinkCalc={deepLinkCalc || undefined} initialQuery={initialQuery || undefined} />
    </>
  );
}
