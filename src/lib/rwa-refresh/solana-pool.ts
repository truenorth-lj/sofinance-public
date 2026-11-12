import "@/lib/engine-host";
import "server-only";
import { rpcConnection } from "@sofinance/engine/rpc";
import {
  assemblePoolRangeApr,
  hasPriceHistory,
  type VolumeProfile,
} from "../pool-range-apr";
import { poolSourceFor } from "../pool-sources/registry";
import { raydiumPoolSource } from "../pool-sources/raydium";
import type { PoolSource } from "../pool-sources/types";
import type { ThrottleGate } from "../range-apr/throttle-gate";
import { getRwaConfig } from "../config/rwa-env";
import { SAVED_PRICE_HISTORY_MAX_AGE_MS } from "../rwa-freshness";
import { volumeWindowEnd } from "../rwa-daily";
import { sanitizePublicError } from "../public-error";
import {
  ALGORITHM_VERSION,
  type ActivePool,
  type Lease,
  type RwaStore,
  type StoredProfile,
} from "../rwa-store-types";

/** fresh: today's price history; stale: computed from saved history; degraded/error: no estimate saved; throttled: 429, nothing saved. */
export type PoolOutcome = "fresh" | "stale" | "degraded" | "error" | "throttled";

/**
 * Profile timestamps survive instance recycling; new UTC windows cannot reuse yesterday's volume sample. The pool's
 * `PoolSource` (by its stored protocol) loads a fresh profile.
 */
export async function refreshProfile(
  pool: ActivePool,
  fetcher: typeof fetch,
  now: number,
  signal: AbortSignal,
  upstream: { gate?: ThrottleGate } = {},
  source: PoolSource = poolSourceFor(pool.pair.protocol),
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
  const fresh = await source.loadProfile(
    pool.pair.poolAddress,
    fetcher,
    Math.floor(now / 1000),
    // The stored row too: a source that reads the pool by its own spec (Meteora's bin step) needs it.
    { retry: { signal }, ...upstream, pair: pool.pair },
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
    now - Date.parse(cached.observedAt) < SAVED_PRICE_HISTORY_MAX_AGE_MS
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


export async function refreshSolanaPool(input: {
  store: RwaStore; lease: Lease; pool: ActivePool; fetcher: typeof fetch; clock: () => number; signal: AbortSignal;
  gate: ThrottleGate; throttled: () => boolean;
  /** Per-pool time limit (the Meteora lane); a pool that hits it saves an error and rotates to the back. */
  poolTimeoutMs?: number;
}): Promise<{ outcome: PoolOutcome; issue: string | null }> {
  const { store, lease, pool, clock, signal } = input;
  const poolId = pool.pair.poolAddress;
  const source = poolSourceFor(pool.pair.protocol);
  // The job signal, or the job signal plus the per-pool limit (same object when there is no limit).
  const poolSignal = input.poolTimeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(input.poolTimeoutMs)]) : signal;
  // Saved under its own protocol (rows without one are Raydium CLMM, as before).
  const protocol = source === raydiumPoolSource ? {} : { protocol: source.id };
  try {
    poolSignal.throwIfAborted();
    await store.request({ op: "renew", lease });
    const [profile, chainSnapshot] = await Promise.all([
      refreshProfile(pool, input.fetcher, clock(), poolSignal, { gate: input.gate }, source),
      source.readLiquidity(
        poolId,
        rpcConnection(undefined, { signal: poolSignal, retry: { budgetMs: 8000 } }),
        pool.pair,
      ).then((chain) => ({
        chain,
        observedAt: new Date(clock()).toISOString(),
      })),
    ]);
    // Its price-history fetch hit a 429: save nothing, so the pool keeps its place at the front of the queue.
    if (input.throttled())
      return { outcome: "throttled", issue: null };
    const chain = chainSnapshot.chain,
      chainObservedAt = chainSnapshot.observedAt;
    if (
      chain.mintA !== profile.profile.economics.mintA ||
      chain.mintB !== profile.profile.economics.mintB
    )
      throw new Error("On-chain pool mint identity mismatch");
    // A source with its own assembly (Meteora) derives its presets there; the shared assembly takes them here.
    const presets = source.assemble ? undefined : source.presets?.(chain);
    const payload = source.assemble
      ? source.assemble(poolId, profile.profile, chain, Math.floor(clock() / 1000))
      : assemblePoolRangeApr(
        poolId,
        profile.profile,
        chain,
        Math.floor(clock() / 1000),
        presets ? { presets } : {},
      );
    payload.sample.windowEndUtc = profile.windowEndUtc;
    payload.sample.windowStartUtc = new Date(
      Date.parse(profile.windowEndUtc) - payload.sample.days * 86_400_000,
    ).toISOString();
    poolSignal.throwIfAborted();
    await store.request({
      op: "saveApr",
      lease,
      data: {
        poolId,
        ...protocol,
        payload,
        profile,
        chainObservedAt,
        issues: profile.profile.issues.slice(0, 20),
      },
    });
    if (payload.sample.degraded) return { outcome: "degraded", issue: `${poolId}: Price history unavailable` };
    if (payload.sample.priceHistoryStale) return { outcome: "stale", issue: `${poolId}: Using previously saved price history` };
    return { outcome: "fresh", issue: null };
  } catch (error) {
    // The source's own rate limit (Meteora datapi 429): save nothing, the pool keeps its place, its lane stops.
    if (source.isThrottleError?.(error)) return { outcome: "throttled", issue: null };
    const timedOut = poolSignal !== signal && poolSignal.aborted && !signal.aborted;
    const message = timedOut
      ? `Pool refresh timed out after ${Math.round(input.poolTimeoutMs! / 1000)} s`
      : sanitizePublicError(
        error,
        "APR refresh failed",
      ).slice(0, 400);
    if (!signal.aborted)
      await store.request({
        op: "saveApr",
        lease,
        data: {
          poolId,
          ...protocol,
          payload: null,
          profile: null,
          chainObservedAt: null,
          issues: [message],
        },
      }).catch(() => undefined);
    return { outcome: "error", issue: `${poolId}: ${message}` };
  }
}

