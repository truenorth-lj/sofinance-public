import "server-only";
import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_DATAPI } from "@sofinance/engine/protocols/meteora/constants";
import { utcDate } from "@/lib/apr-series";
import { parseMeteoraPoolSnapshot } from "@/lib/meteora-daily-apr";
import { sanitizePublicError } from "@/lib/public-error";
import { fetchJsonOnce } from "@/lib/range-apr/upstream-http";
import { FEED_KEY, FEED_KEY_METEORA, SOLANA_FEED_PROTOCOL, SOLANA_POOL_ID } from "@/lib/rwa-store-types";
import type { RwaPairRow } from "@/lib/rwa-pairs";
import { feedRowTvlMints, meteoraSnapshotTvl, type MeteoraTvlMints } from "./snapshot-tvl";
import type { DailyTvlRecord, DailyTvlRecordInput, DailyTvlStats } from "../registry";

/**
 * Meteora daily TVL (`DexModule.recordDailyTvl`), recorded inside the existing APR refresh (no schedule of its own). Meteora publishes no TVL history,
 * so on the first refresh of each UTC day this reads every listed Meteora pool's TVL from the datapi pool endpoint
 * (`/pools/{address}`) and stores it as that day's row (`rwa_meteora_tvl_daily`). Later refreshes the same day only
 * fill pools that have no row yet (a failed read is retried next run); a stored row is never overwritten.
 * Listed = the engine allowlist plus the Meteora RWA feed's unblocked pools (as `listedMeteoraPool`). The feed's own
 * `tvl_usd` is not reused: it is the discovery scan's value, refreshed on its own cadence.
 * A datapi 429 stops the run at once (no new requests; reads already in flight finish); the rest wait for the next run.
 * datapi's TVL leaves out the ScaledUiAmount multiplier (descriptor `tvlIncludesScaledUi: false`), so each saved value
 * adds it from the feed row's last mint read (`tvlScaledUi.mintsRead` + `scaledUiConfigA/B`, evaluated at this run's
 * clock). No mint read here. An allowlisted side on the original SPL Token program is 1 (no extensions possible). A pool
 * still without a known multiplier is saved as published and counted in `scaledUiUnverified`. Rows saved before X3-7 are left as they are.
 */
const METEORA_TVL_BUDGET_MS = 15_000;
const METEORA_TVL_CONCURRENCY = 4;
const METEORA_TVL_TIMEOUT_MS = 5_000;
const MAX_POOLS = 200;


export async function recordMeteoraDailyTvl(input: DailyTvlRecordInput & { apiBase?: string }): Promise<DailyTvlRecord> {
  const { store, lease, fetcher, clock, signal } = input;
  const date = utcDate(Math.floor(clock() / 1000));
  const issues: string[] = [];
  const feed = await store.request({ op: "activePools", feedKeys: [FEED_KEY, FEED_KEY_METEORA] });
  const allowlist = new Map(METEORA_ALLOWLISTED_POOLS.map((pool) => [pool.poolAddress, pool]));
  const listed = new Set(allowlist.keys());
  const rows = new Map<string, RwaPairRow>();
  for (const { pair } of feed ?? []) {
    if (pair.protocol === SOLANA_FEED_PROTOCOL[FEED_KEY_METEORA] && !pair.blocked) { listed.add(pair.poolAddress); rows.set(pair.poolAddress, pair); }
  }
  let unverified = 0;
  const inRegistryUnit = (poolId: string, snapshot: ReturnType<typeof parseMeteoraPoolSnapshot>): number | null => {
    const allowlisted = allowlist.get(poolId), row = rows.get(poolId);
    const mints: MeteoraTvlMints = { ...(row ? feedRowTvlMints(row) : { mintsRead: false }),
      ...(allowlisted ? { tokenProgramX: allowlisted.tokenProgramX, tokenProgramY: allowlisted.tokenProgramY } : {}) };
    const result = meteoraSnapshotTvl(snapshot, mints, clock());
    if (result?.kind === "unverified") unverified += 1;
    return result?.tvlUsd ?? null;
  };
  const pools = [...listed].filter((id) => SOLANA_POOL_ID.test(id)).slice(0, MAX_POOLS);
  const stats: DailyTvlStats = { date, pools: pools.length, alreadySaved: 0, saved: 0, failed: 0 };
  const done = new Set((await store.request({ op: "meteoraTvlDay", date })).pools);
  const missing = pools.filter((id) => !done.has(id));
  stats.alreadySaved = pools.length - missing.length;
  if (!missing.length) return { stats, issues };

  const base = input.apiBase ?? METEORA_DLMM_DATAPI;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(METEORA_TVL_BUDGET_MS)]);
  const saved: { poolId: string; tvlUsd: number }[] = [];
  const problems: string[] = [];
  let next = 0;
  let throttled = false;
  const worker = async () => {
    while (next < missing.length && !budget.aborted && !throttled) {
      const poolId = missing[next++]!;
      const result = await fetchJsonOnce(fetcher, `${base}/pools/${encodeURIComponent(poolId)}`, METEORA_TVL_TIMEOUT_MS, { signal: budget, cache: "no-store" });
      const tvlUsd = result.ok ? inRegistryUnit(poolId, parseMeteoraPoolSnapshot(result.body)) : null;
      if (tvlUsd !== null) saved.push({ poolId, tvlUsd });
      else problems.push(result.ok ? "no TVL in the answer" : result.reason);
      if (!result.ok && result.status === 429) throttled = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(METEORA_TVL_CONCURRENCY, missing.length) }, worker));
  const unread = missing.length - saved.length;
  stats.failed = unread;
  if (throttled) {
    stats.stoppedBy = "429";
    issues.push(`Meteora TVL: datapi answered 429 (rate limited), so the run stopped; ${unread} of ${missing.length} pools not read for ${date}; retried next run`);
  } else if (unread) issues.push(`Meteora TVL: ${unread} of ${missing.length} pools not read for ${date} (${sanitizePublicError(new Error(problems[0] ?? "time budget"), "datapi error").slice(0, 120)}); retried next run`);
  if (unverified) stats.scaledUiUnverified = unverified;
  if (saved.length) stats.saved = (await store.request({ op: "saveMeteoraTvl", lease, data: { date, rows: saved } })).saved;
  return { stats, issues };
}
