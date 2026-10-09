import "server-only";

import { RAYDIUM_API_V3 } from "./rwa-pairs";
import {
  POOL_DAILY_APR_ASSUMPTIONS,
  POOL_DAILY_APR_LABEL,
  buildPoolDailyAprPoints,
  parseGeckoDailyVolumes,
  parseRaydiumLiquidityLine,
  parseRaydiumPoolSnapshot,
  type RaydiumPoolSnapshot,
} from "./pool-daily-apr-math";
import type { DailyAprPoint } from "./apr-series";

export const RAYDIUM_LIQUIDITY_LINE = `${RAYDIUM_API_V3}/pools/line/liquidity`;
export const RAYDIUM_POOL_IDS = `${RAYDIUM_API_V3}/pools/info/ids`;
export const GECKO_TERMINAL_OHLCV =
  "https://api.geckoterminal.com/api/v2/networks/solana/pools";

const STALE_THRESHOLD_MS = 3_600_000;
const USER_AGENT = "SoFinance/0.1 (pool daily APR; +https://github.com/truenorth-lj/sofinance-public)";

export type PoolDailyAprResult = {
  poolId: string;
  label: string;
  assumptions: string;
  feeRate: number | null;
  published: {
    dayFeeApr: number | null;
    weekFeeApr: number | null;
    monthFeeApr: number | null;
  };
  points: DailyAprPoint[];
  sources: string[];
  fetchedAt: string;
  cachedAt?: string;
  stale?: boolean;
  ageSeconds?: number;
};

export type FetchPoolDailyAprOptions = {
  fetcher?: typeof fetch;
  nowSeconds?: number;
  bypassCache?: boolean;
};

type CacheEntry = { key: string; value: PoolDailyAprResult; createdAt: number };
let cache: CacheEntry | null = null;
const refreshLocks = new Map<string, Promise<PoolDailyAprResult>>();

export function getCachedPoolDailyApr(poolId: string): (PoolDailyAprResult & { cacheHit: true }) | null {
  if (!cache || cache.key !== poolId) return null;
  const ageMs = Date.now() - cache.createdAt;
  return {
    ...cache.value,
    cachedAt: new Date(cache.createdAt).toISOString(),
    stale: ageMs > STALE_THRESHOLD_MS,
    ageSeconds: Math.round(ageMs / 1000),
    cacheHit: true,
  };
}

export function clearPoolDailyAprCache() {
  cache = null;
}

async function fetchJson(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Upstream request failed (${response.status})`);
  }
  return response.json();
}

async function safeJson(
  fetcher: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  try {
    const body = await fetchJson(fetcher, url, timeoutMs);
    return { ok: true, body };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "request failed" };
  }
}

export async function fetchPoolDailyApr(
  poolId: string,
  options: FetchPoolDailyAprOptions = {},
): Promise<PoolDailyAprResult> {
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!options.bypassCache && refreshLocks.has(poolId)) {
    return refreshLocks.get(poolId)!;
  }

  const work = (async () => {
    try {
      const idsUrl = `${RAYDIUM_POOL_IDS}?ids=${encodeURIComponent(poolId)}`;
      const lineUrl = `${RAYDIUM_LIQUIDITY_LINE}?id=${encodeURIComponent(poolId)}`;
      const geckoUrl = `${GECKO_TERMINAL_OHLCV}/${encodeURIComponent(poolId)}/ohlcv/day?aggregate=1&limit=90&currency=usd`;

      const [ids, line, gecko] = await Promise.all([
        safeJson(fetcher, idsUrl, 20_000),
        safeJson(fetcher, lineUrl, 20_000),
        safeJson(fetcher, geckoUrl, 20_000),
      ]);

      const sources: string[] = [];
      let snapshot: RaydiumPoolSnapshot = {
        feeRate: null,
        tvlUsd: null,
        dayVolumeUsd: null,
        dayVolumeFeeUsd: null,
        dayFeeApr: null,
        weekFeeApr: null,
        monthFeeApr: null,
      };
      if (ids.ok) {
        snapshot = parseRaydiumPoolSnapshot(ids.body);
        sources.push(`${RAYDIUM_POOL_IDS} (feeRate, current TVL, day/week/month feeApr)`);
      }
      const tvl = line.ok ? parseRaydiumLiquidityLine(line.body) : [];
      if (line.ok) sources.push(`${RAYDIUM_LIQUIDITY_LINE} (daily TVL, ≤30d)`);
      const volumes = gecko.ok ? parseGeckoDailyVolumes(gecko.body) : [];
      if (gecko.ok) sources.push(`${GECKO_TERMINAL_OHLCV}/{pool}/ohlcv/day (USD volume)`);

      if (!ids.ok && !line.ok && !gecko.ok) {
        throw new Error("Pool daily APR upstreams failed");
      }

      const points = buildPoolDailyAprPoints({
        volumes,
        tvl,
        snapshot,
        nowSeconds,
      });

      const result: PoolDailyAprResult = {
        poolId,
        label: POOL_DAILY_APR_LABEL,
        assumptions: POOL_DAILY_APR_ASSUMPTIONS,
        feeRate: snapshot.feeRate,
        published: {
          dayFeeApr: snapshot.dayFeeApr,
          weekFeeApr: snapshot.weekFeeApr,
          monthFeeApr: snapshot.monthFeeApr,
        },
        points,
        sources,
        fetchedAt: new Date(nowSeconds * 1000).toISOString(),
      };
      cache = { key: poolId, value: result, createdAt: Date.now() };
      return result;
    } finally {
      refreshLocks.delete(poolId);
    }
  })();

  if (!options.bypassCache) refreshLocks.set(poolId, work);
  return work;
}
