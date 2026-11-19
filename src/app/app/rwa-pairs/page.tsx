import { HideOnMount } from "@/components/hide-on-mount";
import { PublicPoolsTable, PUBLIC_POOLS_SSR_ID } from "@/components/public-pools-table";
import { PoolsPage } from "@/components/unified-pools/pools-page";
import { loadHomepagePoolsSnapshot } from "@/lib/homepage-pools-snapshot";
import { serializeJsonLd } from "@/lib/json-ld";
import { publicPoolsItemListJsonLd } from "@/lib/public-pools-table";
import { unifiedPoolFlags } from "@/lib/unified-pools/flags";

/**
 * Same window as the homepage snapshot cache. The region-notice cookie in proxy may still keep the document
 * `private, no-store`; the table itself is built from that cached snapshot, with no per-request RPC.
 */
export const revalidate = 900;

/**
 * The pools page: Solana + Robinhood Chain pools in one list. `?openPool=<id>` opens that pool (where `/app/rhc` and old
 * `/app?openPool=` links are redirected); the older `?pool=<id>&open=1` link (MCP `openPositionUrl`, homepage) still works.
 */
export default async function RwaPairsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
  const deepLinkPool = first(query.openPool) || (first(query.open) === "1" ? first(query.pool) : "");
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
      <PublicPoolsTable snapshot={snapshot} />
      <HideOnMount targetId={PUBLIC_POOLS_SSR_ID} />
      <PoolsPage flags={flags} rhcSigningEnabled={rhcSigning} deepLinkPool={deepLinkPool || undefined} />
    </>
  );
}
