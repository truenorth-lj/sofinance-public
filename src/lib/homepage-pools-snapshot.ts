import "server-only";
import { unstable_cache } from "next/cache";
import { getRwaPairs } from "@/lib/rwa-store";
import { getRhcPoolsSnapshot } from "@/lib/rhc-snapshot";
import { isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { RWA_PAIRS_LIST_QUERY } from "@/lib/rwa-pairs-list";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { toHomepagePoolsSnapshot, type HomepagePoolsSnapshot, type HomepageSolanaRow } from "@/lib/homepage-pools";

/** Give up on the server snapshot after this long; the page then falls back to the client fetch. */
const SNAPSHOT_TIMEOUT_MS = 8_000;
/** Same window as the homepage's ISR `revalidate`. */
export const HOMEPAGE_POOLS_REVALIDATE_SECONDS = 900;

type SolanaSource = { pairs: HomepageSolanaRow[]; tokenIcons?: TokenIconMap; fetchedAt: string; stale: boolean };
type RhcSource = { pools: RhcPoolSummary[]; fetchedAt: string; stale: boolean };

async function readSolana(): Promise<SolanaSource> {
  const result = await getRwaPairs(RWA_PAIRS_LIST_QUERY);
  const body = result as typeof result & { freshness?: { snapshotAt: string; stale: boolean }; tokenIcons?: TokenIconMap };
  return {
    pairs: body.pairs as HomepageSolanaRow[],
    tokenIcons: body.tokenIcons,
    fetchedAt: body.fetchedAt,
    stale: body.freshness?.stale ?? false,
  };
}

async function readRhc(): Promise<RhcSource> {
  const result = await getRhcPoolsSnapshot();
  return { pools: result.pools, fetchedAt: result.fetchedAt, stale: result.snapshot?.stale ?? false };
}

/*
 * Data-cache boundaries, one per chain: the store's gateway call is `cache: "no-store"`, which would otherwise turn
 * the homepage into a per-request render. Inside `unstable_cache` the page stays a static ISR prerender. A failed
 * read throws and is never cached, so one chain being down never pins the other's rows out of the HTML.
 */
const cachedSolana = unstable_cache(readSolana, ["homepage-pools-solana-v2"], {
  revalidate: HOMEPAGE_POOLS_REVALIDATE_SECONDS,
  tags: ["homepage-pools"],
});
const cachedRhc = unstable_cache(readRhc, ["homepage-pools-rhc-v1"], {
  revalidate: HOMEPAGE_POOLS_REVALIDATE_SECONDS,
  tags: ["homepage-pools"],
});

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("snapshot timeout")), SNAPSHOT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pools for the homepage's server-rendered HTML (Solana pairs and Robinhood Chain StablePair pools), so crawlers and
 * AI fetchers see pool names, chains and basic stats instead of "Loading pool data…". Reads the same saved snapshots
 * as `/api/rwa-pairs` and `/api/protocol-pools?protocol=uniswap-v4-rhc` (production: store reads per regeneration,
 * never Raydium, indexers or RPC per visitor). If one chain fails the other is still rendered; if both fail it
 * returns null and the table loads on the client exactly as before.
 */
export async function loadHomepagePoolsSnapshot(): Promise<HomepagePoolsSnapshot | null> {
  const [solana, rhc] = await Promise.allSettled([
    withTimeout(cachedSolana()),
    isRhcUniv4DiscoveryEnabled() ? withTimeout(cachedRhc()) : Promise.reject(new Error("disabled")),
  ]);
  if (solana.status === "rejected" && rhc.status === "rejected") return null;
  return toHomepagePoolsSnapshot({
    solana: solana.status === "fulfilled" ? solana.value : null,
    rhc: rhc.status === "fulfilled" ? rhc.value : null,
  });
}
