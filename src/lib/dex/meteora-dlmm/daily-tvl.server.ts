import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_DATAPI } from "@sofinance/engine/protocols/meteora/constants";
import { utcDate } from "@/lib/apr-series";
import { parseMeteoraPoolSnapshot } from "@/lib/meteora-daily-apr";
import { sanitizePublicError } from "@/lib/public-error";
import { fetchJsonOnce } from "@/lib/range-apr/upstream-http";
import { FEED_KEY, FEED_KEY_METEORA, SOLANA_FEED_PROTOCOL, SOLANA_POOL_ID } from "@/lib/rwa-store-types";
import type { DailyTvlRecord, DailyTvlRecordInput, DailyTvlStats } from "../registry";

/**
 * Meteora daily TVL (`DexModule.recordDailyTvl`), recorded inside the existing APR refresh (no schedule of its own). Meteora publishes no TVL history,
 * so on the first refresh of each UTC day this reads every listed Meteora pool's TVL from the datapi pool endpoint
 * (`/pools/{address}`) and stores it as that day's row (`rwa_meteora_tvl_daily`). Later refreshes the same day only
 * fill pools that have no row yet (a failed read is retried next run); a stored row is never overwritten.
 * Listed = the engine allowlist plus the Meteora RWA feed's unblocked pools (as `listedMeteoraPool`). The feed's own
 * `tvl_usd` is not reused: it is the discovery scan's value, refreshed on its own cadence.
 */
export const METEORA_TVL_BUDGET_MS = 15_000;
const METEORA_TVL_CONCURRENCY = 4;
const METEORA_TVL_TIMEOUT_MS = 5_000;
const MAX_POOLS = 200;


export async function recordMeteoraDailyTvl(input: DailyTvlRecordInput & { apiBase?: string }): Promise<DailyTvlRecord> {
  const { store, lease, fetcher, clock, signal } = input;
  const date = utcDate(Math.floor(clock() / 1000));
  const issues: string[] = [];
  const feed = await store.request({ op: "activePools", feedKeys: [FEED_KEY, FEED_KEY_METEORA] });
  const listed = new Set(METEORA_ALLOWLISTED_POOLS.map((pool) => pool.poolAddress));
  for (const { pair } of feed ?? []) {
    if (pair.protocol === SOLANA_FEED_PROTOCOL[FEED_KEY_METEORA] && !pair.blocked) listed.add(pair.poolAddress);
  }
  const pools = [...listed].filter((id) => SOLANA_POOL_ID.test(id)).slice(0, MAX_POOLS);
  const stats: DailyTvlStats = { date, pools: pools.length, alreadySaved: 0, saved: 0, failed: 0 };
  const done = new Set((await store.request({ op: "meteoraTvlDay", date })).pools);
  const missing = pools.filter((id) => !done.has(id));
  stats.alreadySaved = pools.length - missing.length;
  if (!missing.length) return { stats, issues };

  const base = input.apiBase ?? METEORA_DLMM_DATAPI;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(METEORA_TVL_BUDGET_MS)]);
  const rows: { poolId: string; tvlUsd: number }[] = [];
  const problems: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < missing.length && !budget.aborted) {
      const poolId = missing[next++]!;
      const result = await fetchJsonOnce(fetcher, `${base}/pools/${encodeURIComponent(poolId)}`, METEORA_TVL_TIMEOUT_MS, { signal: budget, cache: "no-store" });
      const tvlUsd = result.ok ? parseMeteoraPoolSnapshot(result.body).tvlUsd : null;
      if (tvlUsd !== null) rows.push({ poolId, tvlUsd });
      else problems.push(result.ok ? "no TVL in the answer" : result.reason);
    }
  };
  await Promise.all(Array.from({ length: Math.min(METEORA_TVL_CONCURRENCY, missing.length) }, worker));
  const unread = missing.length - rows.length;
  stats.failed = unread;
  if (unread) issues.push(`Meteora TVL: ${unread} of ${missing.length} pools not read for ${date} (${sanitizePublicError(new Error(problems[0] ?? "time budget"), "datapi error").slice(0, 120)}); retried next run`);
  if (rows.length) stats.saved = (await store.request({ op: "saveMeteoraTvl", lease, data: { date, rows } })).saved;
  return { stats, issues };
}
