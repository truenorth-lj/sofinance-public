import { PoolsPage } from "@/components/unified-pools/pools-page";
import { unifiedPoolFlags } from "@/lib/unified-pools/flags";

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
  return <PoolsPage flags={flags} rhcSigningEnabled={rhcSigning} deepLinkPool={deepLinkPool || undefined} />;
}
