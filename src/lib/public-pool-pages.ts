import { HIGHEST_RANGE_APR_7D_HELP } from "@/lib/apr-labels/copy";
import { formatAprPct } from "@/lib/apr-labels/format-apr";
import { DEX_IDS, normalizeDexId } from "@/lib/dex/types";
import { publicDexLabel } from "@/lib/dex/ui";
import { formatPoolUsd } from "@/lib/format/usd";
import { aprLookupFrom, type HomepagePool, type HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { isSameStockPool } from "@/lib/pool-metrics/same-stock-pair";
import type { JsonLd } from "@/lib/json-ld";
import { poolFeeTierLabel, poolPairLabel } from "@/lib/pool-names";
import {
  APP_ROUTES,
  CANONICAL_SITE_URL,
  buildOpenPositionPath,
  publicPoolPath,
} from "@/lib/public-urls";
import { pageMetadata } from "@/lib/seo";
import { CHAIN_LABELS, type UnifiedPool } from "@/lib/unified-pools/model";

const SLUG_TOKEN = /[^a-z0-9]+/g;
const dash = "—";

/** The only time the phrase "7d APR" may appear on a per-pool page (the facts label). */
export const PUBLIC_POOL_APR_LABEL = "7d APR";

export type PublicPoolPageModel = {
  slug: string;
  path: string;
  pool: HomepagePool;
  pairLabel: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  chain: string;
  dex: string;
  feeTier: string;
  tvl: string;
  volume24h: string;
  apr7d: string;
  aprHelp: string;
  openInAppHref: string;
  listHref: string;
};

export function symbolSlugToken(symbol: string): string {
  return symbol.toLowerCase().replace(SLUG_TOKEN, "") || "token";
}

/** Stable pair token, symbols sorted so A/B and B/A share one base (tsla-tslax, nvda-nvdaon). */
export function publicPoolPairBase(pool: Pick<UnifiedPool, "symbolA" | "symbolB">): string {
  const tokens = [symbolSlugToken(pool.symbolA), symbolSlugToken(pool.symbolB)].sort();
  return `${tokens[0]}-${tokens[1]}`;
}

/** Brand token of the canonical DEX id (raydium-clmm → raydium). Unknown ids still use the first kebab segment. */
export function publicDexSlug(protocol: string): string {
  const canonical = normalizeDexId(protocol);
  const id = canonical ?? protocol.toLowerCase().replace(SLUG_TOKEN, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return id.split("-")[0] || "dex";
}

function protocolPriority(protocol: string): number {
  const canonical = normalizeDexId(protocol);
  return canonical ? DEX_IDS.indexOf(canonical) : DEX_IDS.length + 1;
}

function addressSlugPart(address: string): string {
  const raw = address.replace(/^0x/i, "").toLowerCase().replace(SLUG_TOKEN, "");
  return raw.slice(-6) || "pool";
}

function feeSlugPart(pool: Pick<UnifiedPool, "feeTierBps" | "poolAddress">): string {
  if (typeof pool.feeTierBps === "number" && Number.isFinite(pool.feeTierBps) && pool.feeTierBps >= 0) {
    return `${Math.round(pool.feeTierBps)}bps`;
  }
  return addressSlugPart(pool.poolAddress);
}

/**
 * Stable public slugs for every pool in a snapshot. The unsuffixed pair slug (e.g. tsla-tslax) is given only to the
 * unique pool of the highest-priority registered DEX for that pair; other DEXes get a registry-derived suffix
 * (tsla-tslax-meteora). Same-DEX fee-tier collisions use a fee suffix. Ranking never changes a slug.
 */
export function assignPublicPoolSlugs(pools: readonly UnifiedPool[]): Map<string, string> {
  const byBase = new Map<string, UnifiedPool[]>();
  for (const pool of pools) {
    const base = publicPoolPairBase(pool);
    const list = byBase.get(base);
    if (list) list.push(pool);
    else byBase.set(base, [pool]);
  }

  const slugs = new Map<string, string>();
  const used = new Set<string>();
  const take = (pool: UnifiedPool, candidate: string) => {
    let slug = candidate;
    if (used.has(slug)) slug = `${candidate}-${addressSlugPart(pool.poolAddress)}`;
    let n = 2;
    while (used.has(slug)) {
      slug = `${candidate}-${addressSlugPart(pool.poolAddress)}-${n}`;
      n += 1;
    }
    used.add(slug);
    slugs.set(pool.key, slug);
  };

  for (const [base, group] of [...byBase.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length === 1) {
      take(group[0]!, base);
      continue;
    }
    const byProtocol = new Map<string, UnifiedPool[]>();
    for (const pool of group) {
      const id = normalizeDexId(pool.protocol) ?? pool.protocol;
      const list = byProtocol.get(id);
      if (list) list.push(pool);
      else byProtocol.set(id, [pool]);
    }
    const protocols = [...byProtocol.keys()].sort((a, b) => protocolPriority(a) - protocolPriority(b) || a.localeCompare(b));
    const preferred = protocols[0]!;
    const unsuffixedProtocol = (byProtocol.get(preferred)?.length ?? 0) === 1 ? preferred : null;
    for (const id of protocols) {
      const members = byProtocol.get(id)!;
      const dex = publicDexSlug(id);
      if (members.length === 1) {
        const pool = members[0]!;
        take(pool, id === unsuffixedProtocol ? base : `${base}-${dex}`);
        continue;
      }
      for (const pool of [...members].sort((a, b) => a.key.localeCompare(b.key))) {
        take(pool, `${base}-${dex}-${feeSlugPart(pool)}`);
      }
    }
  }
  return slugs;
}

/** Pools that may appear on /pools/{slug}, the SSR table, the sitemap and public JSON-LD. */
export function seoPublicPools(snapshot: HomepagePoolsSnapshot | null): HomepagePool[] {
  return snapshot ? snapshot.pools.filter(isSameStockPool) : [];
}

export function publicPoolPageModel(pool: HomepagePool, apr7dPct: number | null, slug: string): PublicPoolPageModel {
  const pairLabel = poolPairLabel(pool, " / ");
  const dex = publicDexLabel(pool.protocol);
  const chain = CHAIN_LABELS[pool.chain];
  const title = `${pairLabel} pool on ${dex}`;
  const feeTier = poolFeeTierLabel(pool.feeTierBps);
  const path = publicPoolPath(slug);
  return {
    slug,
    path,
    pool,
    pairLabel,
    title,
    metaTitle: feeTier ? `${title}, ${feeTier} (${chain})` : `${title} (${chain})`,
    metaDescription:
      `${pairLabel} same-stock pool on ${dex} (${chain}): TVL, 24h volume and an estimated 7-day fee APR. Not a prediction. Fees not guaranteed.`,
    chain,
    dex,
    feeTier: feeTier ?? dash,
    tvl: formatPoolUsd(pool.tvlUsd),
    volume24h: formatPoolUsd(pool.volume24hUsd),
    apr7d: formatAprPct(apr7dPct),
    aprHelp: HIGHEST_RANGE_APR_7D_HELP,
    openInAppHref: buildOpenPositionPath(pool.poolAddress),
    listHref: APP_ROUTES.rwaPairs,
  };
}

export function listPublicPoolPageModels(snapshot: HomepagePoolsSnapshot | null): PublicPoolPageModel[] {
  const pools = seoPublicPools(snapshot);
  if (!snapshot || pools.length === 0) return [];
  const slugs = assignPublicPoolSlugs(pools);
  const lookup = aprLookupFrom(snapshot.apr7d);
  return [...pools]
    .sort((a, b) => a.key.localeCompare(b.key))
    .flatMap((pool) => {
      const slug = slugs.get(pool.key);
      return slug ? [publicPoolPageModel(pool, lookup(pool), slug)] : [];
    });
}

export function findPublicPoolPageModel(snapshot: HomepagePoolsSnapshot | null, slug: string): PublicPoolPageModel | null {
  if (!snapshot || !slug) return null;
  return listPublicPoolPageModels(snapshot).find((page) => page.slug === slug) ?? null;
}

export function slugForPool(snapshot: HomepagePoolsSnapshot | null, poolKey: string): string | null {
  const pools = seoPublicPools(snapshot);
  if (pools.length === 0) return null;
  return assignPublicPoolSlugs(pools).get(poolKey) ?? null;
}

/** Server-built `pool.key → /pools/<slug>` map for card and list-row name links. Pools without a slug are omitted. */
export function publicPoolDetailHrefs(snapshot: HomepagePoolsSnapshot | null): Readonly<Record<string, string>> {
  const pools = seoPublicPools(snapshot);
  if (pools.length === 0) return {};
  const slugs = assignPublicPoolSlugs(pools);
  const hrefs: Record<string, string> = {};
  for (const [key, slug] of slugs) hrefs[key] = publicPoolPath(slug);
  return hrefs;
}

export function publicPoolJsonLd(model: PublicPoolPageModel): JsonLd {
  const url = `${CANONICAL_SITE_URL}${model.path}`;
  const listUrl = `${CANONICAL_SITE_URL}${model.listHref}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${url}#page`,
        name: model.metaTitle,
        description: model.metaDescription,
        url,
        isPartOf: { "@id": `${CANONICAL_SITE_URL}/#website` },
        inLanguage: "en",
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: CANONICAL_SITE_URL },
          { "@type": "ListItem", position: 2, name: "Same-stock liquidity pools", item: listUrl },
          { "@type": "ListItem", position: 3, name: model.title, item: url },
        ],
      },
    ],
  };
}

export function publicPoolMetadata(model: PublicPoolPageModel) {
  return pageMetadata({
    title: model.metaTitle,
    description: model.metaDescription,
    path: model.path,
  });
}

export function poolSitemapEntries(
  snapshot: HomepagePoolsSnapshot | null,
  lastModified: string,
): { path: string; lastModified: string; changeFrequency: "daily" }[] {
  return listPublicPoolPageModels(snapshot).map((page) => ({
    path: page.path,
    lastModified,
    changeFrequency: "daily" as const,
  }));
}
