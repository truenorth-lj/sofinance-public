import "server-only";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, asc, between, eq, exists, gt, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { assertRwaDatabaseIdentity } from "./rwa-database";
export { createRwaDatabase } from "./rwa-database";
import { getRwaConfig } from "./config/rwa-env";
import { dailyWindow, validateHistoryRange, volumeWindowEnd } from "./rwa-daily";
import { DEFAULT_PROTOCOL } from "@sofinance/engine/protocols/types";
import { sortPairs, type DiscoverRwaPairsResult, type RwaPairRow } from "./rwa-pairs";
import { pickHighestAprPreset } from "./range-apr/preset-list";
import { RWA_PAIRS_STALE_MS } from "./rwa-freshness";
import {
  ALGORITHM_VERSION, FEED_KEY, PAIRING_VERSION, RwaStoreError, storeRequestSchema,
  type AprWrite, type DiscoveryWrite, type Lease, type RwaStore, type SnapshotApr, type StoreRequest,
} from "./rwa-store-types";

const { backgroundJobState: job, rwaFeedState: feed, rwaPoolLatest: pool,
  rwaAprLatest: apr, rwaAprDaily: daily } = schema;
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

  async request(raw: StoreRequest): Promise<unknown> {
    const input = storeRequestSchema.parse(raw);
    await assertRwaDatabaseIdentity(this.db);
    switch (input.op) {
      case "pairs": return this.readPairs(input.minTvl, input.maxPages, input.sortBy);
      case "apr": return this.readApr(input.poolId);
      case "history": {
        validateHistoryRange(input.from, input.to);
        const rows = await this.orm.select().from(daily).where(and(eq(daily.poolAddress, input.poolId),
          between(daily.snapshotDate, input.from, input.to))).orderBy(asc(daily.snapshotDate));
        return { poolId: input.poolId, timezone: "Asia/Taipei", points: rows.map((row) => ({
          date: row.snapshotDate, capturedAt: row.capturedAt ? iso(row.capturedAt) : null,
          status: row.status, poolFeeAprPct: row.poolFeeAprPct, highestRangeAprPct: row.highestRangeAprPct,
          highestRangeId: row.highestRangeId, presets: row.presets, referenceCapitalUsd: row.referenceCapitalUsd,
          algorithmVersion: row.algorithmVersion, sample: row.sample, reason: row.failureReason,
        })) };
      }
      case "activePools": {
        const rows = await this.orm.select({ pool, profile: apr.profileCache }).from(pool)
          .innerJoin(feed, and(eq(feed.feedKey, pool.feedKey), eq(feed.generationId, pool.lastSeenGeneration)))
          .leftJoin(apr, eq(apr.poolAddress, pool.poolAddress)).where(eq(feed.feedKey, FEED_KEY))
          .orderBy(asc(pool.poolAddress));
        return rows.map((row) => ({ pair: pair(row.pool), metricsObservedAt: iso(row.pool.metricsObservedAt), profile: row.profile }));
      }
      case "claim": {
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
      }
      case "renew": return this.guarded(input.lease, async (tx) => {
        await tx.update(job).set({ leaseExpiresAt: sql`${nowSql}+${interval(getRwaConfig().leaseMs)}` })
          .where(eq(job.jobKey, input.lease.job));
        return true;
      });
      case "finish": return this.guarded(input.lease, async (tx) => {
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
      });
      case "publishDiscovery": return this.publish(input.lease, input.data as DiscoveryWrite);
      case "prepareDaily": return this.prepareDaily(input.lease);
      case "saveApr": return this.saveApr(input.lease, input.data as AprWrite);
    }
  }

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
      freshness: { snapshotAt: published, stale: ageMs > RWA_PAIRS_STALE_MS } };
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
      volumeObservedAt: volume, stale: this.clock() - Date.parse(chain) > 600_000 ||
        this.clock() - Date.parse(volume) > 1_800_000 || row.payload.sample.windowEndUtc !== volumeWindowEnd(this.clock()),
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
          (pool_address,snapshot_date,scheduled_for,mint_a,mint_b,symbol_a,symbol_b,
           tvl_usd,volume_24h_usd,fees_24h_usd,pool_fee_apr_pct,pool_metrics_observed_at,algorithm_version)
          SELECT ${pool.poolAddress},${window.date}::date,${new Date(window.start).toISOString()}::timestamptz,
            ${pool.mintA},${pool.mintB},${pool.symbolA},${pool.symbolB},${pool.tvlUsd},
            ${pool.volume24hUsd},${pool.fees24hUsd},${pool.poolFeeAprPct},${pool.metricsObservedAt},${ALGORITHM_VERSION}
          FROM ${pool} JOIN ${feed} ON ${feed.feedKey}=${pool.feedKey} AND ${feed.generationId}=${pool.lastSeenGeneration}
          WHERE ${feed.feedKey}=${FEED_KEY} AND ${feed.publishedAt}>${new Date(this.clock() - 1_800_000).toISOString()}::timestamptz
            AND NOT EXISTS(SELECT 1 FROM ${daily} WHERE ${daily.snapshotDate}=${window.date}::date)
          ON CONFLICT DO NOTHING`);
      }
      await tx.update(daily).set({ status: sql`CASE WHEN ${daily.failureReason} LIKE 'degraded:%' THEN 'degraded'
        WHEN ${daily.failureReason} IS NOT NULL THEN 'failed' ELSE 'missing' END`, finalizedAt: nowSql })
        .where(and(eq(daily.status, "pending"), sql`${daily.scheduledFor}+interval '1 hour'<=${new Date(this.clock()).toISOString()}::timestamptz`));
      return { date: window.date, eligible: window.eligible };
    });
  }

  private async saveApr(lease: Lease, data: AprWrite) {
    if (lease.job !== "rwa-apr-refresh" || (data.payload && data.payload.poolId !== data.poolId)) throw new RwaStoreError("INVALID_APR");
    const status = data.payload ? data.payload.sample.degraded ? "degraded" : "ok" : "error";
    return this.guarded(lease, async (tx) => {
      const [old] = await tx.select({ payload: apr.payload, profile: apr.profileCache }).from(apr)
        .where(eq(apr.poolAddress, data.poolId)).for("update");
      const replace = !!data.payload && (!data.payload.sample.degraded || !old?.payload || old.payload.sample.degraded);
      const freshProfile = data.profile && !data.profile.profile.stale && (data.profile.profile.candles?.length ?? 0) > 0;
      const profile = freshProfile ? data.profile : old?.profile ?? data.profile;
      const observed = data.profile?.profile.observedAt;
      await tx.insert(apr).values({ poolAddress: data.poolId, algorithmVersion: ALGORITHM_VERSION, lastAttemptStatus: status }).onConflictDoNothing();
      await tx.update(apr).set({ lastAttemptAt: nowSql, lastAttemptStatus: status, lastAttemptIssues: data.issues,
        profileCache: profile }).where(eq(apr.poolAddress, data.poolId));
      if (replace && data.payload) await tx.update(apr).set({ payload: data.payload, payloadSnapshotAt: data.payload.fetchedAt,
        chainObservedAt: data.chainObservedAt, economicsObservedAt: observed?.economics ?? data.profile?.observedAt ?? null,
        volumeObservedAt: observed?.hourly ?? data.profile?.observedAt ?? null, algorithmVersion: ALGORITHM_VERSION,
        referenceCapitalUsd: data.payload.referenceCapitalUsd, payloadSchemaVersion: 1 }).where(eq(apr.poolAddress, data.poolId));
      const window = dailyWindow(this.clock());
      const winner = data.payload && !data.payload.sample.degraded ? pickHighestAprPreset(data.payload.presets) : null;
      const eligible = window.eligible && winner?.estimate.status === "ok" && freshProfile &&
        data.profile!.windowEndUtc === volumeWindowEnd(this.clock()) && this.clock() - Date.parse(data.profile!.observedAt) <= 1_800_000 &&
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
