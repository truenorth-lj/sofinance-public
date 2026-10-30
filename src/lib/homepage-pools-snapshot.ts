import "server-only";
import { unstable_cache } from "next/cache";
import { getRwaPairs } from "@/lib/rwa-store";
import { RWA_PAIRS_LIST_QUERY } from "@/lib/rwa-pairs-list";
import type { TokenIconMap } from "@/lib/token-icons/map";
import { toHomepagePoolsSnapshot, type HomepagePoolsSnapshot } from "@/lib/homepage-pools";

/** Give up on the server snapshot after this long; the page then falls back to the client fetch. */
const SNAPSHOT_TIMEOUT_MS = 8_000;
/** Same window as the homepage's ISR `revalidate`. */
export const HOMEPAGE_POOLS_REVALIDATE_SECONDS = 900;

async function readSnapshot(): Promise<HomepagePoolsSnapshot> {
  const result = await getRwaPairs(RWA_PAIRS_LIST_QUERY);
  const body = result as typeof result & { freshness?: { snapshotAt: string; stale: boolean }; tokenIcons?: TokenIconMap };
  return toHomepagePoolsSnapshot({
    pairs: body.pairs,
    tokenIcons: body.tokenIcons,
    freshness: body.freshness ?? { snapshotAt: body.fetchedAt, stale: false },
  });
}

/**
 * Data-cache boundary: the store's gateway call is `cache: "no-store"`, which would otherwise turn the homepage
 * into a per-request render. Inside `unstable_cache` the page stays a static ISR prerender. A failed read throws
 * and is never cached.
 */
const cachedSnapshot = unstable_cache(readSnapshot, ["homepage-pools-snapshot-v1"], {
  revalidate: HOMEPAGE_POOLS_REVALIDATE_SECONDS,
  tags: ["homepage-pools"],
});

/**
 * Pools for the homepage's server-rendered HTML, so crawlers and AI fetchers see pool names and basic stats
 * instead of "Loading pool data…". Reads the same saved snapshot as `/api/rwa-pairs` (production: one store read
 * per regeneration, never Raydium or RPC per visitor). Any failure returns null: the table then loads on the
 * client exactly as before.
 */
export async function loadHomepagePoolsSnapshot(): Promise<HomepagePoolsSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cachedSnapshot(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("snapshot timeout")), SNAPSHOT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
