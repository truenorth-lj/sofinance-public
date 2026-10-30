import "@/lib/engine-host";
import "server-only";
import { getRwaConfig } from "./config/rwa-env";
import { discoverRwaPairs } from "./rwa-pairs";
import {
  assemblePoolRangeApr,
  hasPriceHistory,
  loadVolumeProfile,
  type VolumeProfile,
} from "./pool-range-apr";
import { readOnchainPoolLiquidity } from "./range-apr/onchain-liquidity";
import { rpcConnection } from "@sofinance/engine/rpc";
import { mapPool } from "@sofinance/engine/jupiter";
import { volumeWindowEnd } from "./rwa-daily";
import { sanitizePublicError } from "./public-error";
import { getRwaStore } from "./rwa-store";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { resolveTokenIcons, rhcIconSources, solanaIconSources } from "./token-icons/resolve";
import type { RwaPairRow } from "./rwa-pairs";
import {
  ALGORITHM_VERSION,
  type ActivePool,
  type DiscoveryWrite,
  type JobName,
  type Lease,
  type RwaStore,
  type StoredProfile,
} from "./rwa-store-types";

type Options = {
  store?: RwaStore;
  force?: boolean;
  fetcher?: typeof fetch;
  clock?: () => number;
};
type JobResult = {
  job: JobName;
  status: "skipped" | "ok" | "partial" | "error";
  processed: number;
  issues: string[];
};

/** Profile timestamps survive instance recycling; new UTC windows cannot reuse yesterday's volume sample. */
export async function refreshProfile(
  pool: ActivePool,
  fetcher: typeof fetch,
  now: number,
  signal: AbortSignal,
): Promise<StoredProfile> {
  const config = getRwaConfig(),
    cached = pool.profile;
  const sameMints = (profile: VolumeProfile) =>
    profile.economics.mintA === pool.pair.mintA &&
    profile.economics.mintB === pool.pair.mintB;
  if (
    cached &&
    cached.algorithmVersion === ALGORITHM_VERSION &&
    sameMints(cached.profile) &&
    hasPriceHistory(cached.profile) &&
    !cached.profile.stale &&
    cached.windowEndUtc === volumeWindowEnd(now) &&
    now - Date.parse(cached.observedAt) < config.profileTtlMs
  )
    return cached;
  const fresh = await loadVolumeProfile(
    pool.pair.poolAddress,
    fetcher,
    Math.floor(now / 1000),
    { retry: { signal } },
  );
  if (!sameMints(fresh)) throw new Error("Pool profile mint identity mismatch");
  const timestamps = [
    fresh.observedAt?.economics,
    fresh.observedAt?.daily,
    fresh.observedAt?.hourly,
  ]
    .filter((x): x is string => !!x)
    .sort();
  if (hasPriceHistory(fresh))
    return {
      algorithmVersion: ALGORITHM_VERSION,
      profile: fresh,
      windowEndUtc: volumeWindowEnd(now),
      observedAt: timestamps[0] ?? new Date(now).toISOString(),
    };
  if (
    cached &&
    cached.algorithmVersion === ALGORITHM_VERSION &&
    sameMints(cached.profile) &&
    hasPriceHistory(cached.profile) &&
    now - Date.parse(cached.observedAt) < 6 * 3_600_000
  ) {
    return {
      ...cached,
      profile: {
        ...fresh,
        daily: fresh.daily ?? cached.profile.daily,
        candles: cached.profile.candles,
        stale: true,
        observedAt: {
          economics: fresh.observedAt?.economics ?? new Date(now).toISOString(),
          daily: fresh.daily
            ? (fresh.observedAt?.daily ?? null)
            : (cached.profile.observedAt?.daily ?? null),
          hourly: cached.profile.observedAt?.hourly ?? cached.observedAt,
        },
        issues: [...fresh.issues, "Using previously saved price history"],
      },
    };
  }
  return {
    algorithmVersion: ALGORITHM_VERSION,
    profile: fresh,
    windowEndUtc: volumeWindowEnd(now),
    observedAt: timestamps[0] ?? new Date(now).toISOString(),
  };
}

async function runJob(job: JobName, options: Options): Promise<JobResult> {
  const store = options.store ?? getRwaStore(),
    config = getRwaConfig(),
    clock = options.clock ?? Date.now;
  const lease = await store.request({
    op: "claim",
    job,
    force: !!options.force,
  });
  if (!lease) return { job, status: "skipped", processed: 0, issues: [] };
  const signal = AbortSignal.timeout(config.jobTimeoutMs),
    issues: string[] = [];
  let processed = 0,
    status: "ok" | "partial" | "error" = "ok";
  try {
    if (job === "rwa-discovery") {
      const result = await discoverRwaPairs({
        minTvl: 0,
        maxPages: config.maxPages,
        sortBy: "estimatedFeeApr",
        fetcher: options.fetcher,
        signal,
      });
      signal.throwIfAborted();
      if (!result.discovery)
        throw new Error("Discovery coverage metadata missing");
      const data: DiscoveryWrite = { result, ...result.discovery };
      await store.request({ op: "publishDiscovery", lease, data });
      processed = result.pairs.length;
      // Best effort: a missing table or an indexer outage leaves the snapshot published and the old icons in place.
      await refreshTokenIcons(store, lease, result.pairs, options.fetcher, signal).catch(() => {
        issues.push("Token icons not saved");
      });
    } else {
      await store.request({ op: "prepareDaily", lease });
      const pools = await store.request({ op: "activePools" });
      await mapPool(pools, config.concurrency, async (pool) => {
        const poolId = pool.pair.poolAddress;
        try {
          signal.throwIfAborted();
          await store.request({ op: "renew", lease });
          const [profile, chainSnapshot] = await Promise.all([
            refreshProfile(pool, options.fetcher ?? fetch, clock(), signal),
            readOnchainPoolLiquidity(
              poolId,
              rpcConnection(undefined, { signal, retry: { budgetMs: 8000 } }),
            ).then((chain) => ({
              chain,
              observedAt: new Date(clock()).toISOString(),
            })),
          ]);
          const chain = chainSnapshot.chain,
            chainObservedAt = chainSnapshot.observedAt;
          if (
            chain.mintA !== profile.profile.economics.mintA ||
            chain.mintB !== profile.profile.economics.mintB
          )
            throw new Error("On-chain pool mint identity mismatch");
          const payload = assemblePoolRangeApr(
            poolId,
            profile.profile,
            chain,
            Math.floor(clock() / 1000),
          );
          payload.sample.windowEndUtc = profile.windowEndUtc;
          payload.sample.windowStartUtc = new Date(
            Date.parse(profile.windowEndUtc) - payload.sample.days * 86_400_000,
          ).toISOString();
          signal.throwIfAborted();
          await store.request({ op: "prepareDaily", lease });
          await store.request({
            op: "saveApr",
            lease,
            data: {
              poolId,
              payload,
              profile,
              chainObservedAt,
              issues: profile.profile.issues.slice(0, 20),
            },
          });
          processed += 1;
          if (payload.sample.degraded)
            issues.push(`${poolId}: Price history unavailable`);
        } catch (error) {
          const message = sanitizePublicError(
            error,
            "APR refresh failed",
          ).slice(0, 400);
          issues.push(`${poolId}: ${message}`);
          if (!signal.aborted)
            await store.request({
              op: "saveApr",
              lease,
              data: {
                poolId,
                payload: null,
                profile: null,
                chainObservedAt: null,
                issues: [message],
              },
            });
        }
      });
      signal.throwIfAborted();
      await store.request({ op: "prepareDaily", lease });
      if (issues.length) status = "partial";
    }
  } catch (error) {
    status = "error";
    issues.push(sanitizePublicError(error, "Refresh failed").slice(0, 400));
  }
  try {
    await store.request({
      op: "finish",
      lease,
      processed,
      outcome: status,
      issues: issues.slice(0, 20),
    });
  } catch {
    status = "error";
    issues.push("Job lease was lost before completion");
  }
  return { job, status, processed, issues: issues.slice(0, 20) };
}

export async function refreshRwaSnapshots(options: Options = {}) {
  // A complete newly published generation is available before APR enumerates its pools.
  const discovery = await runJob("rwa-discovery", options);
  const apr = await runJob("rwa-apr-refresh", options);
  return { discovery, apr };
}

/**
 * Daily token icon pass, run inside the rwa-discovery job after the pool scan: Solana pool tokens (Jupiter → Raydium
 * → manual) and the allowlisted Robinhood Chain pool tokens (DexScreener → GeckoTerminal → manual). Only links that
 * pass `ICON_HOSTS` are written.
 */
export async function refreshTokenIcons(store: RwaStore, lease: Lease, pairs: readonly Pick<RwaPairRow, "mintA" | "mintB">[],
  fetcher: typeof fetch | undefined, signal: AbortSignal) {
  const solana = await resolveTokenIcons("solana", pairs.flatMap((pair) => [pair.mintA, pair.mintB]), solanaIconSources(fetcher), { signal });
  const rhc = await resolveTokenIcons("robinhood",
    UNIV4_RHC_ALLOWLISTED_POOLS.flatMap((pool) => [pool.currency0.address, pool.currency1.address]), rhcIconSources(fetcher), { signal });
  signal.throwIfAborted();
  await store.request({ op: "renew", lease });
  return store.request({ op: "saveTokenIcons", lease, data: [...solana, ...rhc] });
}
