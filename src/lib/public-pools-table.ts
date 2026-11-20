import { HIGHEST_RANGE_APR_7D_HELP } from "@/lib/apr-labels/copy";
import { formatAprPct } from "@/lib/apr-labels/format-apr";
import { formatPoolUsd } from "@/lib/format/usd";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { aprLookupFrom, rwaPairsDefaultOrder } from "@/lib/homepage-pools";
import type { JsonLd } from "@/lib/json-ld";
import { formatFeeTier } from "@/lib/position-label";
import { APP_ROUTES, CANONICAL_SITE_URL, publicPoolPath } from "@/lib/public-urls";
import { publicDexLabel } from "@/lib/dex/ui";
import { assignPublicPoolSlugs, seoPublicPools } from "@/lib/public-pool-pages";
import { CHAIN_LABELS, type UnifiedPool } from "@/lib/unified-pools/model";

export const PUBLIC_POOLS_H1 = "Same-stock liquidity pools";

/**
 * On-page heading for the /app/rwa-pairs crawler table (and the visible subline under the "Pools" h1).
 * Does not say "same-stock" because the interactive list also includes USDC/USDT.
 */
export const PUBLIC_POOLS_SSR_HEADING = "Liquidity pools on Solana and Robinhood Chain";

/** One intro: names the DEXes, states the 7-day window, and includes "Fees not guaranteed." */
export const PUBLIC_POOLS_INTRO =
  `Raydium CLMM and Meteora DLMM on Solana, and Uniswap v4 on Robinhood Chain. ${HIGHEST_RANGE_APR_7D_HELP}`;

/** The only time the phrase "7d APR" may appear on this page (column header). */
export const PUBLIC_POOLS_APR_COLUMN = "7d APR";

export type PublicPoolRow = {
  key: string;
  pairLabel: string;
  chain: string;
  dex: string;
  feeTier: string;
  tvl: string;
  volume24h: string;
  apr7d: string;
  href: string;
};

const dash = "—";

export function toPublicPoolRow(pool: UnifiedPool, apr7dPct: number | null, href: string): PublicPoolRow {
  return {
    key: pool.key,
    pairLabel: `$${pool.symbolA} / $${pool.symbolB}`,
    chain: CHAIN_LABELS[pool.chain],
    dex: publicDexLabel(pool.protocol),
    feeTier: formatFeeTier(pool.feeTierBps) ?? dash,
    tvl: formatPoolUsd(pool.tvlUsd),
    volume24h: formatPoolUsd(pool.volume24hUsd),
    apr7d: formatAprPct(apr7dPct),
    href,
  };
}

/** Default /app/rwa-pairs order (hide duplicates, 7-day estimate high to low). Row links go to /pools/{slug}. */
export function publicPoolRows(snapshot: HomepagePoolsSnapshot | null): PublicPoolRow[] {
  if (!snapshot) return [];
  const pools = seoPublicPools(snapshot);
  if (pools.length === 0) return [];
  const lookup = aprLookupFrom(snapshot.apr7d);
  const slugs = assignPublicPoolSlugs(pools);
  return rwaPairsDefaultOrder(pools, lookup).map((pool) => {
    const slug = slugs.get(pool.key);
    if (!slug) throw new Error(`missing public slug for ${pool.key}`);
    return toPublicPoolRow(pool, lookup(pool), publicPoolPath(slug));
  });
}

export function publicPoolsItemListJsonLd(snapshot: HomepagePoolsSnapshot | null): JsonLd | null {
  const rows = publicPoolRows(snapshot);
  if (rows.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: PUBLIC_POOLS_H1,
    description: PUBLIC_POOLS_INTRO,
    url: `${CANONICAL_SITE_URL}${APP_ROUTES.rwaPairs}`,
    numberOfItems: rows.length,
    itemListElement: rows.map((row, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: `${row.pairLabel} · ${row.dex} · ${row.chain}`,
      url: `${CANONICAL_SITE_URL}${row.href}`,
    })),
  };
}
