import "server-only";
import { unstable_cache } from "next/cache";
import { getPoolAprSnapshot, getRwaPairs } from "@/lib/rwa-store";
import { getRhcAprSnapshot, getRhcPoolsSnapshot } from "@/lib/rhc-snapshot";
import { isRhcApr7dEnabled, isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { summarizeApr7d } from "@/lib/unified-pools/apr7d";
import { samePairKey } from "@/lib/unified-pools/model";
import { RWA_PAIRS_LIST_QUERY } from "@/lib/rwa-pairs-list";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { buildHomepagePools, toHomepagePoolsSnapshot, type HomepagePool, type HomepagePoolsSnapshot, type HomepageSolanaRow } from "@/lib/homepage-pools";

/** Give up on one server snapshot read after this long; the page then falls back to the client fetch. */
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

type AprRef = { key: string; chain: HomepagePool["chain"]; protocol: HomepagePool["protocol"]; poolAddress: string };

/**
 * Estimated highest range APR (7-day) per pool key, read from the same saved APR snapshots as `/api/pool-range-apr`
 * and `/api/protocol-pools/range-apr` and resolved with the same `summarizeApr7d` as `/app/rwa-pairs`. A pool whose
 * read fails, or whose estimate is missing or expired, has no entry (it then ranks like a missing APR on that page).
 */
async function readApr7d(refs: AprRef[]): Promise<Record<string, number>> {
  const now = Date.now();
  const results = await Promise.allSettled(refs.map(async (ref) => {
    const payload = ref.chain === "robinhood" ? await getRhcAprSnapshot(ref.poolAddress) : await getPoolAprSnapshot(ref.poolAddress);
    const state = summarizeApr7d(payload, ref.protocol, now);
    return state.status === "ready" ? ([ref.key, state.aprPct] as const) : null;
  }));
  // Every read failing (store down) throws, so that result is never cached for the next 15 minutes.
  if (refs.length > 0 && results.every((result) => result.status === "rejected")) throw new Error("APR snapshots unavailable");
  return Object.fromEntries(results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : [])));
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

const cachedApr7d = unstable_cache(readApr7d, ["homepage-pools-apr7d-v1"], {
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
  const input = {
    solana: solana.status === "fulfilled" ? solana.value : null,
    rhc: rhc.status === "fulfilled" ? rhc.value : null,
  };
  // The 7-day APR only decides between pools of the same chain and pair, so only those pools are read. Only Solana
  // pools and (with RHC_APR7D_ENABLED) Robinhood Chain pools have a 7-day APR, as on `/app/rwa-pairs`.
  const candidates = buildHomepagePools({ solana: input.solana?.pairs, rhc: input.rhc?.pools });
  const perPair = new Map<string, number>();
  for (const pool of candidates) perPair.set(samePairKey(pool), (perPair.get(samePairKey(pool)) ?? 0) + 1);
  const refs: AprRef[] = candidates
    .filter((pool) => (perPair.get(samePairKey(pool)) ?? 0) > 1 && (pool.chain === "solana" || isRhcApr7dEnabled()))
    .map(({ key, chain, protocol, poolAddress }) => ({ key, chain, protocol, poolAddress }));
  // Without the APRs the duplicate rule falls back to TVL; the client re-applies it once it has loaded them.
  const apr7d = await withTimeout(cachedApr7d(refs)).catch(() => ({}));
  return toHomepagePoolsSnapshot({ ...input, apr7d });
}
