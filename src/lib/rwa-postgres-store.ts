import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import "server-only";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, asc, between, eq, exists, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { assertRwaDatabaseIdentity } from "./rwa-database";
export { createRwaDatabase } from "./rwa-database";
import { getRwaConfig } from "./config/rwa-env";
import { dailyWindow, validateHistoryRange, volumeWindowEnd } from "./rwa-daily";
import { DEFAULT_PROTOCOL } from "@sofinance/engine/protocols/types";
import { sortPairs, type DiscoverRwaPairsResult, type RwaPairRow } from "./rwa-pairs";
import { pickHighestAprPreset } from "./range-apr/preset-list";
import { RWA_PAIRS_STALE_MS, aprSnapshotDelayed } from "./rwa-freshness";
import {
  ALGORITHM_VERSION, FEED_KEY, FEED_KEY_RHC, PAIRING_VERSION, RwaStoreError, storeRequestSchema,
  type AprWrite, type DiscoveryWrite, type Lease, type RwaStore, type SnapshotApr, type StoreRequest, type StoreOperation, type RhcRosterRow, type StoredProfile, type StoreResultMap, type StoreHandlers,
} from "./rwa-store-types";

import { tokenIconMap, type TokenIconRow } from "./token-icons/map";
import { logSafeError } from "./safe-error-log";

const { backgroundJobState: job, rwaFeedState: feed, rwaPoolLatest: pool,
  rwaAprLatest: apr, rwaAprDaily: daily, rwaTokenIcon: tokenIcon } = schema;

/** Postgres undefined_table / undefined_column: `drizzle/0002_token-icons.sql` not applied yet. */
export function isMissingRelation(error: unknown): boolean {
  for (let e = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (code === "42P01" || code === "42703") return true;
  }
  return false;
}

/** Runs the icon query; a missing table/column (or any read error) yields no rows instead of failing the caller. */
export async function tolerantTokenIcons(query: () => Promise<TokenIconRow[]>): Promise<TokenIconRow[]> {
  try {
    return await query();
  } catch (error) {
    if (!isMissingRelation(error)) logSafeError("[rwa] token icons unreadable; using fallback icons", error);
    return [];
  }
}
type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const nowSql = sql`clock_timestamp()`;
const iso = (value: string) => new Date(value).toISOString();
const interval = (ms: number) => sql`(${ms}::integer * interval '1 millisecond')`;
// The scheduler probes on wall-clock boundaries (default every 15 minutes) while a
// job's next due time is lastStartedAt + cadence, a few ms after the boundary. A
// small grace keeps a 15-minute job from slipping to every other probe.
const DUE_GRACE = sql`interval '60 seconds'`;
const leaseWhere = (lease: Lease) => and(eq(job.jobKey, lease.job),
  eq(job.leaseOwner, lease.owner), eq(job.leaseEpoch, lease.epoch));


function pair(row: typeof pool.$inferSelect): RwaPairRow {
  // Rows persisted before the protocol field existed are Raydium CLMM pools.
  return { protocol: DEFAULT_PROTOCOL, ...row.details, poolAddress: row.poolAddress, mintA: row.mintA, mintB: row.mintB,
    symbolA: row.symbolA, symbolB: row.symbolB, tvlUsd: row.tvlUsd,
    volume24hUsd: row.volume24hUsd, fees24hUsd: row.fees24hUsd, feeRate: row.feeRate,
    estimatedFeeAprPct: row.poolFeeAprPct } as RwaPairRow;
}

export class PostgresRwaStore implements RwaStore {
  private readonly orm: Database;
  constructor(public readonly db: postgres.Sql, private readonly clock: () => number = Date.now) {
    this.orm = drizzle(db, { schema });
  }

  /** Keep the lease row locked through commit; expiry checks fence every write. */
  private async guarded<T>(lease: Lease, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.orm.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL transaction_timeout = '8s'`);
      const valid = async () => (await tx.select({ key: job.jobKey }).from(job)
        .where(and(leaseWhere(lease), gt(job.leaseExpiresAt, nowSql))).for("update")).length > 0;
      if (!(await valid())) throw new RwaStoreError("LEASE_LOST");
      const result = await work(tx);
      if (!(await valid())) throw new RwaStoreError("LEASE_LOST");
      return result;
    });
  }

  async request<K extends StoreOperation>(raw: StoreRequest<K>): Promise<StoreResultMap[K]> {
    // Zod validates/defaults fields and preserves the discriminator; it cannot infer generic K.
    const input = storeRequestSchema.parse(raw) as StoreRequest<K>;
    await assertRwaDatabaseIdentity(this.db);
    return this.handlers[input.op](input);
  }

  private readonly handlers: StoreHandlers = {
    pairs: input => this.readPairs(input.minTvl, input.maxPages, input.sortBy),
    apr: input => this.readApr(input.poolId),
    history: async input => {
      validateHistoryRange(input.from, input.to);
      const rows = await this.orm.select().from(daily).where(and(eq(daily.poolAddress, input.poolId),
        between(daily.snapshotDate, input.from, input.to))).orderBy(asc(daily.snapshotDate));
      return { poolId: input.poolId, timezone: "Asia/Taipei", points: rows.map((row) => ({
        date: row.snapshotDate, capturedAt: row.capturedAt ? iso(row.capturedAt) : null,
        status: row.status, poolFeeAprPct: row.poolFeeAprPct, highestRangeAprPct: row.highestRangeAprPct,
        highestRangeId: row.highestRangeId, presets: row.presets, referenceCapitalUsd: row.referenceCapitalUsd,
        algorithmVersion: row.algorithmVersion, sample: row.sample, reason: row.failureReason,
      })) };
    },
    activePools: async () => {
      const rows = await this.orm.select({ pool, profile: apr.profileCache }).from(pool)
        .innerJoin(feed, and(eq(feed.feedKey, pool.feedKey), eq(feed.generationId, pool.lastSeenGeneration)))
        .leftJoin(apr, eq(apr.poolAddress, pool.poolAddress)).where(eq(feed.feedKey, FEED_KEY))
        .orderBy(asc(pool.poolAddress));
      return rows.map((row) => ({ pair: pair(row.pool), metricsObservedAt: iso(row.pool.metricsObservedAt), profile: row.profile }));
    },
    claim: async input => {
      const owner = randomUUID();
      const rows = await this.orm.transaction(async (tx) => {
        await tx.insert(job).values({ jobKey: input.job }).onConflictDoNothing();
        return tx.update(job).set({ leaseOwner: owner, leaseEpoch: sql`${job.leaseEpoch}+1`,
          leaseExpiresAt: sql`${nowSql}+${interval(getRwaConfig().leaseMs)}`,
          lastStartedAt: nowSql, lastStatus: "running" })
          .where(and(eq(job.jobKey, input.job), or(isNull(job.leaseOwner), lte(job.leaseExpiresAt, nowSql)),
            input.force ? sql`true` : or(isNull(job.nextDueAt), lte(job.nextDueAt, sql`${nowSql}+${DUE_GRACE}`))))
          .returning({ epoch: job.leaseEpoch });
      });
      return rows.length ? { job: input.job, owner, epoch: rows[0]!.epoch } : null;
    },
    renew: input => this.guarded(input.lease, async (tx) => {
      await tx.update(job).set({ leaseExpiresAt: sql`${nowSql}+${interval(getRwaConfig().leaseMs)}` })
        .where(eq(job.jobKey, input.lease.job));
      return true;
    }),
    finish: input => this.guarded(input.lease, async (tx) => {
      const config = getRwaConfig();
      const cadence = input.lease.job === "rwa-discovery" ? config.discoveryIntervalMs : config.aprIntervalMs;
      await tx.update(job).set({ lastCompletedAt: nowSql,
        lastSuccessAt: input.outcome === "ok" ? nowSql : job.lastSuccessAt,
        nextDueAt: sql`GREATEST(${nowSql}+interval '10 seconds', ${job.lastStartedAt}+${interval(input.outcome === "error" ? Math.min(cadence, 300_000) : cadence)})`,
        lastStatus: input.outcome, consecutiveFailures: input.outcome === "ok" ? 0 : sql`${job.consecutiveFailures}+1`,
        lastDurationMs: sql`GREATEST(0,round(extract(epoch FROM(${nowSql}-${job.lastStartedAt}))*1000)::integer)`,
        lastError: input.issues.length ? { issues: input.issues } : null,
        lastSummary: { processed: input.processed, issueCount: input.issues.length },
      }).where(eq(job.jobKey, input.lease.job));
      return true;
    }).then(async (result) => {
      // Release only the same epoch after the final expiry check, never a replacement lease.
      await this.orm.update(job).set({ leaseOwner: null, leaseExpiresAt: null }).where(leaseWhere(input.lease));
      return result;
    }),
    publishDiscovery: input => this.publish(input.lease, input.data),
    prepareDaily: input => this.prepareDaily(input.lease),
    saveApr: input => this.saveApr(input.lease, input.data),
    saveTokenIcons: input => this.saveTokenIcons(input.lease, input.data),
    ensureRhcRoster: input => this.ensureRhcRoster(input.lease, input.data as RhcRosterRow[]),
    rhcPools: () => this.readRhcPools(),
  };

  private async readPairs(minTvl: number, maxPages: number, sortBy: "estimatedFeeApr" | "tvl" | "volume24h") {
    // One statement gives feed and pools the same MVCC snapshot during generation publication.
    const rows = await this.orm.select({ feed, pool }).from(feed).leftJoin(pool, and(
      eq(pool.feedKey, feed.feedKey), eq(pool.lastSeenGeneration, feed.generationId),
      lte(pool.sourcePage, maxPages), sql`COALESCE(${pool.tvlUsd},0)>=${minTvl}`,
    )).where(eq(feed.feedKey, FEED_KEY));
    const state = rows[0]?.feed;
    if (!state?.generationId || !state.publishedAt) throw new RwaStoreError("SNAPSHOT_UNAVAILABLE");
    if (maxPages > state.scanMaxPages) throw new RwaStoreError("SNAPSHOT_COVERAGE_UNAVAILABLE");
    const published = iso(state.publishedAt), ageMs = this.clock() - Date.parse(published);
    const pages = Math.min(maxPages, state.pagesFetched);
    return { ...(state.summary as Omit<DiscoverRwaPairsResult, "pairs">),
      pairs: sortPairs(rows.flatMap((row) => row.pool ? [pair(row.pool)] : []), sortBy),
      pagesFetched: pages, scannedPools: state.pagePoolCounts.slice(0, pages).reduce((sum, n) => sum + n, 0),
      fetchedAt: published, cachedAt: published, stale: ageMs > RWA_PAIRS_STALE_MS, ageSeconds: Math.floor(ageMs / 1000),
      freshness: { snapshotAt: published, stale: ageMs > RWA_PAIRS_STALE_MS },
      tokenIcons: tokenIconMap(await this.readTokenIcons()) };
  }

  /**
   * Stored icons, or none when the table is missing (migration 0002 not applied), empty, or unreadable: icons are
   * cosmetic, so this never fails the pairs read. `tokenIconMap` then fills in the manual list, and the cards fall
   * back to the Raydium icon path and finally the letter avatar.
   */
  private readTokenIcons(): Promise<TokenIconRow[]> {
    return tolerantTokenIcons(() => this.orm.select({ chain: tokenIcon.chain, address: tokenIcon.address,
      image: tokenIcon.image, source: tokenIcon.source }).from(tokenIcon));
  }


  /** Seed the RHC feed + allowlisted pool rows so APR snapshots can FK to them. */
  /**
   * Upsert the allowlisted RHC pools into `rwa_pool_latest` (feed `uniswap-v4-rhc-v1`) with the cron's pool
   * summaries (TVL / 24h volume / hook fee / checks), and return each pool's saved price-history profile so the
   * cron can skip OHLCV calls it does not need.
   */
  private async ensureRhcRoster(lease: Lease, rows: RhcRosterRow[]): Promise<StoreResultMap["ensureRhcRoster"]> {
    if (lease.job !== "rwa-apr-refresh") throw new RwaStoreError("INVALID_JOB");
    const allowed = new Map(UNIV4_RHC_ALLOWLISTED_POOLS.map((spec) => [spec.poolId.toLowerCase(), spec]));
    if (rows.some((row) => !allowed.has(row.poolId.toLowerCase()))) throw new RwaStoreError("INVALID_RHC_ROSTER");
    const generation = "00000000-0000-4000-8000-0000000000a1";
    return this.guarded(lease, async (tx) => {
      await tx.insert(feed).values({
        feedKey: FEED_KEY_RHC, pairingRuleVersion: "uniswap-v4-rhc-allowlist-v1",
        generationId: generation, scanMaxPages: 1, pagesFetched: 1,
        scannedPools: rows.length, pagePoolCounts: [rows.length],
        publishedAt: nowSql as unknown as string,
        summary: { source: "allowlist", pairingRuleSummary: "StablePairHook allowlist", estimatedFeeAprLabel: "Estimated" },
      }).onConflictDoUpdate({
        target: feed.feedKey,
        set: {
          generationId: generation, scannedPools: rows.length, pagePoolCounts: [rows.length],
          publishedAt: nowSql as unknown as string, pairingRuleVersion: "uniswap-v4-rhc-allowlist-v1",
        },
      });
      for (const row of rows) {
        const spec = allowed.get(row.poolId.toLowerCase())!;
        const market = row.summary.estimatedApr;
        const values = {
          chain: "robinhood" as const, protocol: "uniswap-v4-rhc" as const,
          mintA: spec.currency0.address.toLowerCase(), mintB: spec.currency1.address.toLowerCase(),
          symbolA: spec.currency0.symbol, symbolB: spec.currency1.symbol,
          tvlUsd: market?.tvlUsd ?? null, volume24hUsd: market?.volume24hUsd ?? null,
          fees24hUsd: market ? market.volume24hUsd * market.feeRatePct / 100 : null,
          feeRate: market ? market.feeRatePct / 100 : null, poolFeeAprPct: market?.estimatedPoolFeeAprPct ?? null,
          details: row.summary as unknown as Record<string, unknown>, sourcePage: 1, lastSeenGeneration: generation,
          metricsObservedAt: nowSql as unknown as string,
        };
        await tx.insert(pool).values({ poolAddress: spec.poolId.toLowerCase(), feedKey: FEED_KEY_RHC, ...values })
          .onConflictDoUpdate({ target: pool.poolAddress, set: { ...values, lastSeenAt: nowSql as unknown as string } });
      }
      const saved = await tx.select({ poolAddress: apr.poolAddress, profile: apr.profileCache }).from(apr)
        .where(inArray(apr.poolAddress, rows.map((row) => row.poolId.toLowerCase())));
      const profiles = Object.fromEntries(rows.map((row) => [row.poolId.toLowerCase(), null])) as Record<string, StoredProfile | null>;
      for (const row of saved) profiles[row.poolAddress] = row.profile ?? null;
      return { pools: rows.length, profiles };
    });
  }

  /** The RHC pool summaries the cron saved last (allowlist order). Never touches RPC or indexers. */
  private async readRhcPools(): Promise<StoreResultMap["rhcPools"]> {
    const rows = await this.orm.select({ pool }).from(pool).innerJoin(feed, and(eq(feed.feedKey, pool.feedKey),
      eq(feed.generationId, pool.lastSeenGeneration))).where(eq(feed.feedKey, FEED_KEY_RHC));
    if (!rows.length) throw new RwaStoreError("SNAPSHOT_UNAVAILABLE");
    const order = new Map(UNIV4_RHC_ALLOWLISTED_POOLS.map((spec, index) => [spec.poolId.toLowerCase(), index]));
    const sorted = rows.map((row) => row.pool).filter((row) => order.has(row.poolAddress))
      .sort((a, b) => order.get(a.poolAddress)! - order.get(b.poolAddress)!);
    const observed = sorted.map((row) => Date.parse(iso(row.metricsObservedAt))).filter(Number.isFinite);
    const oldest = observed.length ? Math.min(...observed) : NaN;
    return {
      pools: sorted.map((row) => row.details as unknown as RhcRosterRow["summary"]),
      observedAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
      stale: !Number.isFinite(oldest) || this.clock() - oldest > RWA_PAIRS_STALE_MS,
    };
  }

  /** Upsert icon links found by the daily discovery job; rows already passed the `ICON_HOSTS` check in the schema. */
  private async saveTokenIcons(lease: Lease, rows: TokenIconRow[]) {
    if (!rows.length) return { saved: 0 };
    try {
      return await this.guarded(lease, async (tx) => {
        await tx.insert(tokenIcon).values(rows.map((row) => ({ ...row, updatedAt: sql`clock_timestamp()` as unknown as string })))
          .onConflictDoUpdate({ target: [tokenIcon.chain, tokenIcon.address],
            set: { image: sql`excluded.image`, source: sql`excluded.source`, updatedAt: sql`clock_timestamp()` } });
        return { saved: rows.length };
      });
    } catch (error) {
      if (isMissingRelation(error)) throw new RwaStoreError("TOKEN_ICONS_UNAVAILABLE");
      throw error;
    }
  }

  private async readApr(poolId: string): Promise<SnapshotApr> {
    const rows = await this.orm.select({ apr }).from(pool).leftJoin(apr, eq(apr.poolAddress, pool.poolAddress))
      .where(eq(pool.poolAddress, poolId));
    if (!rows.length) throw new RwaStoreError("POOL_NOT_TRACKED");
    const row = rows[0]!.apr;
    if (!row?.payload || !row.payloadSnapshotAt) throw new RwaStoreError("SNAPSHOT_UNAVAILABLE");
    const chain = iso(row.chainObservedAt ?? row.payloadSnapshotAt), volume = iso(row.volumeObservedAt ?? row.payloadSnapshotAt);
    return { ...row.payload, freshness: { snapshotAt: iso(row.payloadSnapshotAt), chainObservedAt: chain,
      economicsObservedAt: row.economicsObservedAt ? iso(row.economicsObservedAt) : undefined,
      volumeObservedAt: volume, stale: aprSnapshotDelayed({ chainObservedAt: chain, volumeObservedAt: volume,
        windowEndUtc: row.payload.sample.windowEndUtc }, this.clock()),
      lastAttemptStatus: row.lastAttemptStatus } };
  }

  private async publish(lease: Lease, data: DiscoveryWrite) {
    if (lease.job !== "rwa-discovery" || data.pageCounts.length !== data.result.pagesFetched ||
      data.pageCounts.reduce((a, b) => a + b, 0) !== data.result.scannedPools ||
      new Set(data.result.pairs.map((p) => p.poolAddress)).size !== data.result.pairs.length)
      throw new RwaStoreError("INVALID_DISCOVERY");
    const generation = randomUUID();
    return this.guarded(lease, async (tx) => {
      await tx.insert(feed).values({ feedKey: FEED_KEY, pairingRuleVersion: PAIRING_VERSION }).onConflictDoNothing();
      for (const row of data.result.pairs) {
        const page = data.sourcePages[row.poolAddress], observed = data.poolObservedAt[row.poolAddress];
        if (!page || page > data.result.pagesFetched || !observed) throw new RwaStoreError("INVALID_DISCOVERY");
        const values = { mintA: row.mintA, mintB: row.mintB, symbolA: row.symbolA, symbolB: row.symbolB,
          tvlUsd: row.tvlUsd, volume24hUsd: row.volume24hUsd, fees24hUsd: row.fees24hUsd,
          feeRate: row.feeRate, poolFeeAprPct: row.estimatedFeeAprPct, details: row, sourcePage: page,
          lastSeenGeneration: generation, metricsObservedAt: observed };
        await tx.insert(pool).values({ poolAddress: row.poolAddress, feedKey: FEED_KEY, ...values })
          .onConflictDoUpdate({ target: pool.poolAddress, set: { ...values, lastSeenAt: nowSql } });
      }
      await tx.update(feed).set({ generationId: generation, scanMaxPages: getRwaConfig().maxPages,
        pagesFetched: data.result.pagesFetched, scannedPools: data.result.scannedPools, pagePoolCounts: data.pageCounts,
        publishedAt: data.result.fetchedAt, qualificationObservedAt: data.qualificationObservedAt,
        pairingRuleVersion: PAIRING_VERSION, summary: { source: data.result.source,
          pairingRuleSummary: data.result.pairingRuleSummary, estimatedFeeAprLabel: data.result.estimatedFeeAprLabel },
      }).where(eq(feed.feedKey, FEED_KEY));
      return { generation, pools: data.result.pairs.length };
    });
  }

  private async prepareDaily(lease: Lease) {
    if (lease.job !== "rwa-apr-refresh") throw new RwaStoreError("INVALID_JOB");
    const window = dailyWindow(this.clock());
    return this.guarded(lease, async (tx) => {
      if (window.eligible) {
        // One insert-select freezes the roster once per day under the APR job lease.
        await tx.execute(sql`INSERT INTO ${daily}
          (pool_address,chain,protocol,snapshot_date,scheduled_for,mint_a,mint_b,symbol_a,symbol_b,
           tvl_usd,volume_24h_usd,fees_24h_usd,pool_fee_apr_pct,pool_metrics_observed_at,algorithm_version)
          SELECT ${pool.poolAddress},${pool.chain},${pool.protocol},${window.date}::date,${new Date(window.start).toISOString()}::timestamptz,
            ${pool.mintA},${pool.mintB},${pool.symbolA},${pool.symbolB},${pool.tvlUsd},
            ${pool.volume24hUsd},${pool.fees24hUsd},${pool.poolFeeAprPct},${pool.metricsObservedAt},${ALGORITHM_VERSION}
          FROM ${pool} JOIN ${feed} ON ${feed.feedKey}=${pool.feedKey} AND ${feed.generationId}=${pool.lastSeenGeneration}
          WHERE ${feed.feedKey} IN (${FEED_KEY},${FEED_KEY_RHC}) AND ${feed.publishedAt}>${new Date(this.clock() - 1_800_000).toISOString()}::timestamptz
            AND NOT EXISTS(SELECT 1 FROM ${daily} d JOIN ${pool} p ON p.pool_address=d.pool_address
              WHERE d.snapshot_date=${window.date}::date AND p.feed_key=${feed.feedKey})
          ON CONFLICT DO NOTHING`);
      }
      await tx.update(daily).set({ status: sql`CASE WHEN ${daily.failureReason} LIKE 'degraded:%' THEN 'degraded'
        WHEN ${daily.failureReason} IS NOT NULL THEN 'failed' ELSE 'missing' END`, finalizedAt: nowSql })
        .where(and(eq(daily.status, "pending"), sql`${daily.scheduledFor}+interval '1 hour'<=${new Date(this.clock()).toISOString()}::timestamptz`));
      return { date: window.date, eligible: window.eligible };
    });
  }

  private async saveApr(lease: Lease, data: AprWrite): Promise<StoreResultMap["saveApr"]> {
    if (lease.job !== "rwa-apr-refresh" || (data.payload && data.payload.poolId !== data.poolId)) throw new RwaStoreError("INVALID_APR");
    const status = data.payload ? data.payload.sample.degraded ? "degraded" : "ok" : "error";
    return this.guarded(lease, async (tx) => {
      const [old] = await tx.select({ payload: apr.payload, profile: apr.profileCache }).from(apr)
        .where(eq(apr.poolAddress, data.poolId)).for("update");
      const replace = !!data.payload && (!data.payload.sample.degraded || !old?.payload || old.payload.sample.degraded);
      const freshProfile = data.profile && !data.profile.profile.stale && (data.profile.profile.candles?.length ?? 0) > 0;
      const profile = freshProfile ? data.profile : old?.profile ?? data.profile;
      const observed = data.profile?.profile.observedAt;
      const isRhc = /^0x[0-9a-f]{64}$/i.test(data.poolId);
      await tx.insert(apr).values({
        poolAddress: data.poolId, algorithmVersion: ALGORITHM_VERSION, lastAttemptStatus: status,
        ...(isRhc ? { chain: "robinhood", protocol: "uniswap-v4-rhc" } : {}),
      }).onConflictDoNothing();
      await tx.update(apr).set({ lastAttemptAt: nowSql, lastAttemptStatus: status, lastAttemptIssues: data.issues,
        profileCache: profile }).where(eq(apr.poolAddress, data.poolId));
      if (replace && data.payload) await tx.update(apr).set({ payload: data.payload, payloadSnapshotAt: data.payload.fetchedAt,
        chainObservedAt: data.chainObservedAt, economicsObservedAt: observed?.economics ?? data.profile?.observedAt ?? null,
        volumeObservedAt: observed?.hourly ?? data.profile?.observedAt ?? null, algorithmVersion: ALGORITHM_VERSION,
        referenceCapitalUsd: data.payload.referenceCapitalUsd, payloadSchemaVersion: 1 }).where(eq(apr.poolAddress, data.poolId));
      const window = dailyWindow(this.clock());
      const winner = data.payload && !data.payload.sample.degraded ? pickHighestAprPreset(data.payload.presets) : null;
      const eligible = window.eligible && winner?.estimate.status === "ok" && freshProfile &&
        data.profile!.windowEndUtc === volumeWindowEnd(this.clock()) &&
        // RHC reuses a same-UTC-day price history (its OHLCV calls are spaced across runs); Raydium's is ≤30 min old.
        (isRhc || this.clock() - Date.parse(data.profile!.observedAt) <= 1_800_000) &&
        !!data.chainObservedAt && Date.parse(data.chainObservedAt) >= window.start;
      const pending = and(eq(daily.poolAddress, data.poolId), eq(daily.snapshotDate, window.date), eq(daily.status, "pending"));
      if (eligible && data.payload && winner?.estimate.status === "ok") {
        await tx.update(daily).set({ status: "ok", capturedAt: data.payload.fetchedAt, finalizedAt: nowSql,
          highestRangeAprPct: winner.estimate.aprPct, highestRangeId: winner.id, tickLower: winner.tickLower,
          tickUpper: winner.tickUpper, priceLower: winner.priceLower, priceUpper: winner.priceUpper,
          presets: data.payload.presets, referenceCapitalUsd: data.payload.referenceCapitalUsd, chainObservedAt: data.chainObservedAt,
          economicsObservedAt: observed?.economics ?? data.profile!.observedAt, volumeObservedAt: observed?.hourly ?? data.profile!.observedAt,
          sample: data.payload.sample, failureReason: null,
        }).where(and(pending, exists(tx.select({ one: sql`1` }).from(pool).where(and(eq(pool.poolAddress, daily.poolAddress),
          gt(pool.metricsObservedAt, new Date(this.clock() - 1_800_000).toISOString()))))));
      } else if (window.eligible && status !== "ok") {
        await tx.update(daily).set({ failureReason: `${status}:${data.issues.join("; ").slice(0, 400)}` }).where(pending);
      }
      return { poolId: data.poolId, status };
    });
  }
}
