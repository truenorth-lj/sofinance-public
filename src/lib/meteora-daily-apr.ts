import { METEORA_DLMM_DATAPI } from "@sofinance/engine/protocols/meteora/constants";
import { SECONDS_PER_DAY, isIncompleteUtcDay, lastCompleteUtcDayStart, utcDate, utcDayStart, type DailyAprPoint } from "./apr-series";
import { POOL_DAILY_APR_LABEL } from "./pool-daily-apr-math";
import type { PoolDailyAprResult } from "./pool-daily-apr";
import { parseDatapiVolumeHistory } from "./range-apr/meteora-datapi-history";
import { fetchJsonOnce } from "./range-apr/upstream-http";
import { estimateFeeAprPct } from "./rwa-pairing";

/**
 * Daily fee APR series for a Meteora DLMM pool, in the same shape as the Raydium series (`PoolDailyAprResult`), so
 * /api/pool-daily-apr and the Plan page treat both alike.
 *
 * Meteora's datapi has daily volume and fees (`/pools/{address}/volume/history`) but no TVL history. The APR refresh
 * stores each listed pool's datapi TVL once per UTC day (`dex/meteora-dlmm/daily-tvl.server.ts`, `rwa_meteora_tvl_daily`); a day with
 * a stored row is divided by that TVL, any other day by the pool's current TVL (`/pools/{address}`). `assumptions`
 * says which, and how many days had a stored TVL.
 */
const ASSUMPTION_FEES = "Fees and volume: Meteora datapi daily volume history (total fees, protocol share included; dynamic fees included).";
const ASSUMPTION_TAIL = [
  "feeRate: Meteora base fee. Ignores concentrated range, IL and rewards.",
  "The pool's creation day and the current incomplete UTC day are omitted (partial days would understate APR).",
];

/** How the series' TVL was chosen: stored daily rows for `storedDays` of its points, today's TVL for the rest. */
export type MeteoraTvlBasis = { storedDays: number; days: number; storeProblem?: string };

function meteoraDailyAprAssumptions(basis: MeteoraTvlBasis = { storedDays: 0, days: 0 }): string {
  const tvl = basis.storedDays > 0
    ? `TVL: Meteora publishes no TVL history, so SoFinance stores the Meteora datapi pool TVL once per UTC day (at that day's first APR refresh); ${basis.storedDays} of ${basis.days} days use that day's stored TVL. Other days use today's TVL, so their APR is off by however much TVL has changed since.`
    : `TVL: Meteora publishes no TVL history, and no stored daily TVL covers these days${basis.storeProblem ? ` (${basis.storeProblem})` : ""}. Other days use today's TVL from the Meteora datapi pool endpoint, so a day's APR is off by however much TVL has changed since.`;
  return [
    "Each point is (that UTC day's fees ÷ that day's stored TVL, or today's TVL when none is stored) × 365 × 100.",
    ASSUMPTION_FEES, tvl, ...ASSUMPTION_TAIL,
  ].join(" ");
}

const METEORA_DAILY_APR_DAYS = 90;
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 3_600_000;
/** A degraded answer (`PoolDailyAprResult.degraded`) is reused for a minute only. */
export const DEGRADED_CACHE_TTL_MS = 60_000;
const CACHE_MAX = 64;

export type FetchMeteoraPoolDailyAprOptions = {
  fetcher?: typeof fetch;
  nowSeconds?: number;
  apiBase?: string;
  bypassCache?: boolean;
  /** Stored daily TVL (`date` → USD) for the pool between two UTC days; a throw means "unavailable", never a failure. */
  storedTvl?: (poolId: string, from: string, to: string) => Promise<ReadonlyMap<string, number>>;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type MeteoraPoolSnapshot = {
  tvlUsd: number | null;
  /** Fraction (0.0001 = 0.01%). */
  baseFeeRate: number | null;
  /** Rolling 24h fee APR, percent. */
  dayFeeAprPct: number | null;
  createdAtSeconds: number | null;
};

/** `/pools/{address}`: current TVL, base fee, rolling 24h fee/TVL (percent) and creation time (ms). */
export function parseMeteoraPoolSnapshot(body: unknown): MeteoraPoolSnapshot {
  const pool = record(body);
  const tvl = finite(pool?.tvl);
  const baseFeePct = finite(record(pool?.pool_config)?.base_fee_pct);
  const ratio24h = finite(record(pool?.fee_tvl_ratio)?.["24h"]);
  const createdMs = finite(pool?.created_at);
  return {
    tvlUsd: tvl !== null && tvl >= 0 ? tvl : null,
    baseFeeRate: baseFeePct !== null && baseFeePct >= 0 ? baseFeePct / 100 : null,
    dayFeeAprPct: ratio24h !== null && ratio24h >= 0 ? ratio24h * 365 : null,
    createdAtSeconds: createdMs !== null && createdMs > 0 ? Math.floor(createdMs / 1000) : null,
  };
}

/**
 * One point per complete UTC day after the pool's creation day: datapi volume, datapi fees ÷ that day's stored TVL when
 * there is one, else the current TVL. Zero-volume days after creation are real zeros (datapi returns a row), not gaps.
 */
export function buildMeteoraDailyAprPoints(input: {
  days: readonly { time: number; volumeUsd: number; feesUsd: number }[];
  tvlUsd: number | null;
  createdAtSeconds: number | null;
  nowSeconds: number;
  /** UTC day (`YYYY-MM-DD`) → stored TVL in USD. */
  storedTvl?: ReadonlyMap<string, number>;
}): DailyAprPoint[] {
  const firstFullDay = input.createdAtSeconds === null ? null : utcDayStart(input.createdAtSeconds) + SECONDS_PER_DAY;
  const byDay = new Map<number, { volumeUsd: number; feesUsd: number }>();
  for (const day of input.days) byDay.set(utcDayStart(day.time), { volumeUsd: day.volumeUsd, feesUsd: day.feesUsd });
  const points: DailyAprPoint[] = [];
  for (const time of [...byDay.keys()].sort((a, b) => a - b)) {
    if (firstFullDay !== null && time < firstFullDay) continue;
    if (isIncompleteUtcDay(time, input.nowSeconds)) continue;
    const { volumeUsd, feesUsd } = byDay.get(time)!;
    const date = utcDate(time);
    const tvlUsd = input.storedTvl?.get(date) ?? input.tvlUsd;
    const aprPct = tvlUsd !== null ? estimateFeeAprPct(feesUsd, tvlUsd) : null;
    points.push({ time, date, aprPct, volumeUsd, tvlUsd });
  }
  return points;
}

/** The stored daily TVL, or none with the reason it could not be read (the series then uses today's TVL throughout). */
async function readStoredTvl(poolId: string, from: string, to: string, reader: FetchMeteoraPoolDailyAprOptions["storedTvl"]):
  Promise<{ tvl: ReadonlyMap<string, number>; problem?: string }> {
  if (!reader) return { tvl: new Map() };
  try {
    return { tvl: await reader(poolId, from, to) };
  } catch {
    return { tvl: new Map(), problem: "the stored daily TVL could not be read" };
  }
}

const cache = new Map<string, { value: PoolDailyAprResult; createdAt: number }>();
const inflight = new Map<string, Promise<PoolDailyAprResult>>();

export function clearMeteoraPoolDailyAprCache() {
  cache.clear();
  inflight.clear();
}

export async function fetchMeteoraPoolDailyApr(poolId: string, options: FetchMeteoraPoolDailyAprOptions = {}): Promise<PoolDailyAprResult> {
  if (!options.bypassCache) {
    const hit = cache.get(poolId);
    if (hit && Date.now() - hit.createdAt < (hit.value.degraded ? DEGRADED_CACHE_TTL_MS : CACHE_TTL_MS)) return hit.value;
    const running = inflight.get(poolId);
    if (running) return running;
  }
  const work = load(poolId, options).finally(() => inflight.delete(poolId));
  if (!options.bypassCache) inflight.set(poolId, work);
  return work;
}

async function load(poolId: string, options: FetchMeteoraPoolDailyAprOptions): Promise<PoolDailyAprResult> {
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const base = options.apiBase ?? METEORA_DLMM_DATAPI;
  const id = encodeURIComponent(poolId);
  const start = lastCompleteUtcDayStart(nowSeconds) - (METEORA_DAILY_APR_DAYS - 1) * SECONDS_PER_DAY;
  const revalidate = { next: { revalidate: 3_600 } } as RequestInit;
  const [pool, history, stored] = await Promise.all([
    fetchJsonOnce(fetcher, `${base}/pools/${id}`, TIMEOUT_MS, revalidate),
    fetchJsonOnce(fetcher, `${base}/pools/${id}/volume/history?timeframe=24h&start_time=${start}&end_time=${nowSeconds}`, TIMEOUT_MS, revalidate),
    readStoredTvl(poolId, utcDate(start), utcDate(lastCompleteUtcDayStart(nowSeconds)), options.storedTvl),
  ]);
  const days = history.ok ? parseDatapiVolumeHistory(history.body) : null;
  if (!pool.ok && !days) {
    const historyProblem = history.ok ? "unusable response" : history.reason;
    throw new Error(`Meteora datapi did not answer for this pool (pool: ${pool.reason}; volume history: ${historyProblem})`);
  }
  const snapshot: MeteoraPoolSnapshot = pool.ok
    ? parseMeteoraPoolSnapshot(pool.body)
    : { tvlUsd: null, baseFeeRate: null, dayFeeAprPct: null, createdAtSeconds: null };
  const sources: string[] = [];
  if (pool.ok) sources.push(`${base}/pools/{address} (current TVL, base fee, 24h fee/TVL)`);
  if (days) sources.push(`${base}/pools/{address}/volume/history (daily USD volume and fees)`);
  const points = buildMeteoraDailyAprPoints({ days: days ?? [], tvlUsd: snapshot.tvlUsd, createdAtSeconds: snapshot.createdAtSeconds, nowSeconds,
    storedTvl: stored.tvl });
  const storedDays = points.filter((point) => stored.tvl.has(point.date)).length;
  if (storedDays) sources.push(`SoFinance store: the Meteora datapi pool TVL saved once per UTC day (${storedDays} ${storedDays === 1 ? "day" : "days"})`);
  const degraded = [
    !pool.ok && `the Meteora datapi pool endpoint did not answer (${pool.reason})`,
    !days && `the Meteora datapi volume history did not answer (${history.ok ? "unusable response" : history.reason})`,
    stored.problem,
  ].filter((reason): reason is string => Boolean(reason));
  const result: PoolDailyAprResult = {
    poolId,
    label: POOL_DAILY_APR_LABEL,
    assumptions: meteoraDailyAprAssumptions({ storedDays, days: points.length, storeProblem: stored.problem }),
    feeRate: snapshot.baseFeeRate,
    published: { dayFeeApr: snapshot.dayFeeAprPct, weekFeeApr: null, monthFeeApr: null },
    points,
    sources,
    fetchedAt: new Date(nowSeconds * 1000).toISOString(),
    ...(degraded.length ? { degraded: degraded.join("; ") } : {}),
  };
  if (!options.bypassCache) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(poolId, { value: result, createdAt: Date.now() });
  }
  return result;
}
