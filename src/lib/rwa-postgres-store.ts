import "server-only";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { getRwaConfig } from "./config/rwa-env";
import {
  dailyWindow,
  validateHistoryRange,
  volumeWindowEnd,
} from "./rwa-daily";
import {
  sortPairs,
  type DiscoverRwaPairsResult,
  type RwaPairRow,
} from "./rwa-pairs";
import { pickHighestAprPreset } from "./range-apr/preset-list";
import type { PoolRangeAprPayload } from "./range-apr/types";
import {
  ALGORITHM_VERSION,
  FEED_KEY,
  PAIRING_VERSION,
  RwaStoreError,
  storeRequestSchema,
  type AprWrite,
  type DiscoveryWrite,
  type Lease,
  type RwaStore,
  type SnapshotApr,
  type StoreRequest,
  type StoredProfile,
} from "./rwa-store-types";

type Params = (string | number | boolean | null)[];
type Query = postgres.Sql;
type Row = Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value);
const nullableJson = (value: unknown) =>
  value === null || value === undefined ? null : json(value);
const iso = (value: unknown) =>
  new Date(
    value instanceof Date ? value.getTime() : String(value),
  ).toISOString();
const numeric = (value: unknown) => (value === null ? null : Number(value));

export function createRwaDatabase(url: string, schema = "public") {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error("Invalid database schema");
  try {
    const target = new URL(url);
    if (
      !["postgres:", "postgresql:"].includes(target.protocol) ||
      decodeURIComponent(target.username) !== "sofinance" ||
      target.pathname !== "/sofinance"
    )
      throw new Error();
  } catch {
    throw new Error("Use the dedicated sofinance database and role");
  }
  const config = getRwaConfig();
  return postgres(url, {
    max: config.poolMax,
    connect_timeout: config.connectTimeoutMs / 1000,
    idle_timeout: 20,
    max_lifetime: 600,
    prepare: false,
    connection: {
      options: `-c search_path=${schema} -c statement_timeout=${config.queryTimeoutMs} -c lock_timeout=3000`,
    },
    onnotice: () => {},
  });
}

function pair(row: Row): RwaPairRow {
  return {
    ...(row.details as RwaPairRow),
    poolAddress: String(row.pool_address),
    mintA: String(row.mint_a),
    mintB: String(row.mint_b),
    symbolA: String(row.symbol_a),
    symbolB: String(row.symbol_b),
    tvlUsd: numeric(row.tvl_usd),
    volume24hUsd: numeric(row.volume_24h_usd),
    fees24hUsd: numeric(row.fees_24h_usd),
    feeRate: numeric(row.fee_rate),
    estimatedFeeAprPct: numeric(row.pool_fee_apr_pct),
  };
}

export class PostgresRwaStore implements RwaStore {
  constructor(
    public readonly db: Query,
    private readonly clock: () => number = Date.now,
  ) {}
  private q(db: Query, statement: string, params: Params = []) {
    return db.unsafe<Row[]>(statement, params);
  }

  /** Lock the lease row through commit, and check expiry again after the write. */
  private async guarded<T>(
    lease: Lease,
    work: (tx: Query) => Promise<T>,
  ): Promise<T> {
    return this.db.begin(async (tx) => {
      await this.q(tx, "SET LOCAL transaction_timeout = '8s'");
      const valid = async () =>
        (
          await this.q(
            tx,
            `SELECT job_key FROM background_job_state WHERE job_key=$1 AND lease_owner=$2
         AND lease_epoch=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
            [lease.job, lease.owner, lease.epoch],
          )
        ).length > 0;
      if (!(await valid())) throw new RwaStoreError("LEASE_LOST");
      const result = await work(tx);
      if (!(await valid())) throw new RwaStoreError("LEASE_LOST");
      return result;
    }) as Promise<T>;
  }

  async request(raw: StoreRequest): Promise<unknown> {
    const input = storeRequestSchema.parse(raw);
    switch (input.op) {
      case "pairs":
        return this.readPairs(input.minTvl, input.maxPages, input.sortBy);
      case "apr":
        return this.readApr(input.poolId);
      case "history": {
        validateHistoryRange(input.from, input.to);
        const rows = await this.q(
          this.db,
          `SELECT snapshot_date::text AS date, captured_at, status,
          pool_fee_apr_pct, highest_range_apr_pct, highest_range_id, presets, reference_capital_usd,
          algorithm_version, sample, failure_reason FROM rwa_apr_daily
          WHERE pool_address=$1 AND snapshot_date BETWEEN $2::date AND $3::date ORDER BY snapshot_date`,
          [input.poolId, input.from, input.to],
        );
        return {
          poolId: input.poolId,
          timezone: "Asia/Taipei",
          points: rows.map((row) => ({
            date: row.date,
            capturedAt: row.captured_at ? iso(row.captured_at) : null,
            status: row.status,
            poolFeeAprPct: numeric(row.pool_fee_apr_pct),
            highestRangeAprPct: numeric(row.highest_range_apr_pct),
            highestRangeId: row.highest_range_id,
            presets: row.presets,
            referenceCapitalUsd: numeric(row.reference_capital_usd),
            algorithmVersion: row.algorithm_version,
            sample: row.sample,
            reason: row.failure_reason,
          })),
        };
      }
      case "activePools": {
        const rows = await this.q(
          this.db,
          `SELECT p.*, a.profile_cache FROM rwa_pool_latest p
          JOIN rwa_feed_state f ON f.feed_key=p.feed_key AND f.generation_id=p.last_seen_generation
          LEFT JOIN rwa_apr_latest a USING(pool_address) WHERE f.feed_key=$1 ORDER BY p.pool_address`,
          [FEED_KEY],
        );
        return rows.map((row) => ({
          pair: pair(row),
          metricsObservedAt: iso(row.metrics_observed_at),
          profile: row.profile_cache ?? null,
        }));
      }
      case "claim": {
        const config = getRwaConfig();
        const owner = randomUUID();
        const rows = await this.db.begin(async (tx) => {
          await this.q(
            tx,
            `INSERT INTO background_job_state(job_key) VALUES($1) ON CONFLICT DO NOTHING`,
            [input.job],
          );
          return this.q(
            tx,
            `UPDATE background_job_state SET lease_owner=$2, lease_epoch=lease_epoch+1,
            lease_expires_at=clock_timestamp()+($3::integer*interval '1 millisecond'),
            last_started_at=clock_timestamp(),last_status='running'
            WHERE job_key=$1 AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp())
            AND ($4::boolean OR next_due_at IS NULL OR next_due_at<=clock_timestamp()) RETURNING lease_epoch`,
            [input.job, owner, config.leaseMs, !!input.force],
          );
        });
        return rows.length
          ? { job: input.job, owner, epoch: Number(rows[0]!.lease_epoch) }
          : null;
      }
      case "renew":
        return this.guarded(input.lease, async (tx) => {
          await this.q(
            tx,
            `UPDATE background_job_state SET lease_expires_at=clock_timestamp()+($2::integer*interval '1 millisecond') WHERE job_key=$1`,
            [input.lease.job, getRwaConfig().leaseMs],
          );
          return true;
        });
      case "finish":
        return this.guarded(input.lease, async (tx) => {
          const config = getRwaConfig();
          const interval =
            input.lease.job === "rwa-discovery"
              ? config.discoveryIntervalMs
              : config.aprIntervalMs;
          // Release happens after the guarded callback so its final expiry check remains meaningful.
          await this.q(
            tx,
            `UPDATE background_job_state SET last_completed_at=clock_timestamp(),
          last_success_at=CASE WHEN $2='ok' THEN clock_timestamp() ELSE last_success_at END,
          next_due_at=GREATEST(clock_timestamp()+interval '10 seconds',last_started_at+($3::integer*interval '1 millisecond')),
          last_status=$2, consecutive_failures=CASE WHEN $2='ok' THEN 0 ELSE consecutive_failures+1 END,
          last_duration_ms=GREATEST(0,round(extract(epoch FROM(clock_timestamp()-last_started_at))*1000)::integer),
          last_error=$4::text::jsonb,last_summary=$5::text::jsonb WHERE job_key=$1`,
            [
              input.lease.job,
              input.outcome,
              input.outcome === "error"
                ? Math.min(interval, 300_000)
                : interval,
              nullableJson(
                input.issues.length ? { issues: input.issues } : null,
              ),
              json({
                processed: input.processed,
                issueCount: input.issues.length,
              }),
            ],
          );
          return true;
        }).then(async (result) => {
          // CAS prevents this release from clearing a lease that has already been taken over.
          await this.q(
            this.db,
            `UPDATE background_job_state SET lease_owner=NULL,lease_expires_at=NULL
          WHERE job_key=$1 AND lease_owner=$2 AND lease_epoch=$3`,
            [input.lease.job, input.lease.owner, input.lease.epoch],
          );
          return result;
        });
      case "publishDiscovery":
        return this.publish(input.lease, input.data as DiscoveryWrite);
      case "prepareDaily":
        return this.prepareDaily(input.lease);
      case "saveApr":
        return this.saveApr(input.lease, input.data as AprWrite);
    }
  }

  private async readPairs(
    minTvl: number,
    maxPages: number,
    sortBy: "estimatedFeeApr" | "tvl" | "volume24h",
  ) {
    const rows = await this.q(
      this.db,
      `SELECT to_jsonb(f) AS feed,
      COALESCE(jsonb_agg(to_jsonb(p)) FILTER(WHERE p.pool_address IS NOT NULL),'[]'::jsonb) AS pools
      FROM rwa_feed_state f LEFT JOIN rwa_pool_latest p ON p.feed_key=f.feed_key
      AND p.last_seen_generation=f.generation_id AND p.source_page<=$2 AND COALESCE(p.tvl_usd,0)>=$3
      WHERE f.feed_key=$1 GROUP BY f.feed_key`,
      [FEED_KEY, maxPages, minTvl],
    );
    const feed = rows[0]?.feed as Row | undefined;
    if (!feed?.generation_id || !feed.published_at)
      throw new RwaStoreError("SNAPSHOT_UNAVAILABLE");
    if (maxPages > Number(feed.scan_max_pages))
      throw new RwaStoreError("SNAPSHOT_COVERAGE_UNAVAILABLE");
    const published = iso(feed.published_at);
    const ageMs = this.clock() - Date.parse(published);
    const pages = Math.min(maxPages, Number(feed.pages_fetched));
    return {
      ...(feed.summary as Omit<DiscoverRwaPairsResult, "pairs">),
      pairs: sortPairs((rows[0]!.pools as Row[]).map(pair), sortBy),
      pagesFetched: pages,
      scannedPools: (feed.page_pool_counts as number[])
        .slice(0, pages)
        .reduce((sum, n) => sum + n, 0),
      fetchedAt: published,
      cachedAt: published,
      stale: ageMs > 1_800_000,
      ageSeconds: Math.floor(ageMs / 1000),
      freshness: { snapshotAt: published, stale: ageMs > 1_800_000 },
    };
  }

  private async readApr(poolId: string): Promise<SnapshotApr> {
    const rows = await this.q(
      this.db,
      `SELECT a.*,p.pool_address AS tracked_pool FROM rwa_pool_latest p
      LEFT JOIN rwa_apr_latest a USING(pool_address) WHERE p.pool_address=$1`,
      [poolId],
    );
    const row = rows[0];
    if (!row) throw new RwaStoreError("POOL_NOT_TRACKED");
    if (!row?.payload) throw new RwaStoreError("SNAPSHOT_UNAVAILABLE");
    const payload = row.payload as PoolRangeAprPayload;
    const chain = row.chain_observed_at
      ? iso(row.chain_observed_at)
      : iso(row.payload_snapshot_at);
    const volume = row.volume_observed_at
      ? iso(row.volume_observed_at)
      : iso(row.payload_snapshot_at);
    const stale =
      this.clock() - Date.parse(chain) > 600_000 ||
      this.clock() - Date.parse(volume) > 1_800_000 ||
      payload.sample.windowEndUtc !== volumeWindowEnd(this.clock());
    return {
      ...payload,
      freshness: {
        snapshotAt: iso(row.payload_snapshot_at),
        chainObservedAt: chain,
        economicsObservedAt: row.economics_observed_at
          ? iso(row.economics_observed_at)
          : undefined,
        volumeObservedAt: volume,
        stale,
        lastAttemptStatus: String(row.last_attempt_status),
      },
    };
  }

  private async publish(lease: Lease, data: DiscoveryWrite) {
    if (
      lease.job !== "rwa-discovery" ||
      data.pageCounts.length !== data.result.pagesFetched ||
      data.pageCounts.reduce((a, b) => a + b, 0) !== data.result.scannedPools ||
      new Set(data.result.pairs.map((p) => p.poolAddress)).size !==
        data.result.pairs.length
    )
      throw new RwaStoreError("INVALID_DISCOVERY");
    const generation = randomUUID();
    return this.guarded(lease, async (tx) => {
      await this.q(
        tx,
        `INSERT INTO rwa_feed_state(feed_key,pairing_rule_version) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [FEED_KEY, PAIRING_VERSION],
      );
      for (const row of data.result.pairs) {
        const page = data.sourcePages[row.poolAddress],
          observed = data.poolObservedAt[row.poolAddress];
        if (!page || page > data.result.pagesFetched || !observed)
          throw new RwaStoreError("INVALID_DISCOVERY");
        await this.q(
          tx,
          `INSERT INTO rwa_pool_latest(pool_address,feed_key,mint_a,mint_b,symbol_a,symbol_b,
          tvl_usd,volume_24h_usd,fees_24h_usd,fee_rate,pool_fee_apr_pct,details,source_page,last_seen_generation,metrics_observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb,$13,$14,$15)
          ON CONFLICT(pool_address) DO UPDATE SET mint_a=EXCLUDED.mint_a,mint_b=EXCLUDED.mint_b,
          symbol_a=EXCLUDED.symbol_a,symbol_b=EXCLUDED.symbol_b,tvl_usd=EXCLUDED.tvl_usd,
          volume_24h_usd=EXCLUDED.volume_24h_usd,fees_24h_usd=EXCLUDED.fees_24h_usd,
          fee_rate=EXCLUDED.fee_rate,pool_fee_apr_pct=EXCLUDED.pool_fee_apr_pct,details=EXCLUDED.details,
          source_page=EXCLUDED.source_page,last_seen_generation=EXCLUDED.last_seen_generation,
          metrics_observed_at=EXCLUDED.metrics_observed_at,last_seen_at=clock_timestamp()`,
          [
            row.poolAddress,
            FEED_KEY,
            row.mintA,
            row.mintB,
            row.symbolA,
            row.symbolB,
            row.tvlUsd,
            row.volume24hUsd,
            row.fees24hUsd,
            row.feeRate,
            row.estimatedFeeAprPct,
            json(row),
            page,
            generation,
            observed,
          ],
        );
      }
      await this.q(
        tx,
        `UPDATE rwa_feed_state SET generation_id=$2,scan_max_pages=$3,pages_fetched=$4,
        scanned_pools=$5,page_pool_counts=$6::text::jsonb,published_at=$7,qualification_observed_at=$8::text::jsonb,
        pairing_rule_version=$9,summary=$10::text::jsonb WHERE feed_key=$1`,
        [
          FEED_KEY,
          generation,
          getRwaConfig().maxPages,
          data.result.pagesFetched,
          data.result.scannedPools,
          json(data.pageCounts),
          data.result.fetchedAt,
          json(data.qualificationObservedAt),
          PAIRING_VERSION,
          json({
            source: data.result.source,
            pairingRuleSummary: data.result.pairingRuleSummary,
            estimatedFeeAprLabel: data.result.estimatedFeeAprLabel,
          }),
        ],
      );
      return { generation, pools: data.result.pairs.length };
    });
  }

  private async prepareDaily(lease: Lease) {
    if (lease.job !== "rwa-apr-refresh") throw new RwaStoreError("INVALID_JOB");
    const window = dailyWindow(this.clock());
    return this.guarded(lease, async (tx) => {
      if (window.eligible) {
        await this.q(
          tx,
          `INSERT INTO rwa_apr_daily(pool_address,snapshot_date,scheduled_for,mint_a,mint_b,symbol_a,symbol_b,
          tvl_usd,volume_24h_usd,fees_24h_usd,pool_fee_apr_pct,pool_metrics_observed_at,algorithm_version)
          SELECT p.pool_address,$2::date,$3,p.mint_a,p.mint_b,p.symbol_a,p.symbol_b,p.tvl_usd,
          p.volume_24h_usd,p.fees_24h_usd,p.pool_fee_apr_pct,p.metrics_observed_at,$4 FROM rwa_pool_latest p
          JOIN rwa_feed_state f ON f.feed_key=p.feed_key AND f.generation_id=p.last_seen_generation
          WHERE f.feed_key=$1 AND f.published_at>$5::timestamptz
          AND NOT EXISTS(SELECT 1 FROM rwa_apr_daily WHERE snapshot_date=$2::date)
          ON CONFLICT DO NOTHING`,
          [
            FEED_KEY,
            window.date,
            new Date(window.start).toISOString(),
            ALGORITHM_VERSION,
            new Date(this.clock() - 1_800_000).toISOString(),
          ],
        );
      }
      await this.q(
        tx,
        `UPDATE rwa_apr_daily SET status=CASE WHEN failure_reason LIKE 'degraded:%' THEN 'degraded'
        WHEN failure_reason IS NOT NULL THEN 'failed' ELSE 'missing' END,finalized_at=clock_timestamp()
        WHERE status='pending' AND scheduled_for+interval '1 hour'<=$1::timestamptz`,
        [new Date(this.clock()).toISOString()],
      );
      return { date: window.date, eligible: window.eligible };
    });
  }

  private async saveApr(lease: Lease, data: AprWrite) {
    if (
      lease.job !== "rwa-apr-refresh" ||
      (data.payload && data.payload.poolId !== data.poolId)
    )
      throw new RwaStoreError("INVALID_APR");
    const status = data.payload
      ? data.payload.sample.degraded
        ? "degraded"
        : "ok"
      : "error";
    return this.guarded(lease, async (tx) => {
      const old = (
        await this.q(
          tx,
          `SELECT payload,profile_cache FROM rwa_apr_latest WHERE pool_address=$1 FOR UPDATE`,
          [data.poolId],
        )
      )[0];
      const replace =
        !!data.payload &&
        (!data.payload.sample.degraded ||
          !old?.payload ||
          (old.payload as PoolRangeAprPayload).sample.degraded);
      const freshProfile =
        data.profile &&
        !data.profile.profile.stale &&
        (data.profile.profile.candles?.length ?? 0) > 0;
      const profile = freshProfile
        ? data.profile
        : ((old?.profile_cache as StoredProfile | undefined) ?? data.profile);
      const observed = data.profile?.profile.observedAt;
      await this.q(
        tx,
        `INSERT INTO rwa_apr_latest(pool_address,algorithm_version,last_attempt_status) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING`,
        [data.poolId, ALGORITHM_VERSION, status],
      );
      await this.q(
        tx,
        `UPDATE rwa_apr_latest SET last_attempt_at=clock_timestamp(),last_attempt_status=$2,
        last_attempt_issues=$3::text::jsonb,profile_cache=$4::text::jsonb WHERE pool_address=$1`,
        [data.poolId, status, json(data.issues), nullableJson(profile)],
      );
      if (replace) {
        await this.q(
          tx,
          `UPDATE rwa_apr_latest SET payload=$2::text::jsonb,payload_snapshot_at=$3,
          chain_observed_at=$4,economics_observed_at=$5,volume_observed_at=$6,algorithm_version=$7,
          reference_capital_usd=$8,payload_schema_version=1 WHERE pool_address=$1`,
          [
            data.poolId,
            json(data.payload),
            data.payload!.fetchedAt,
            data.chainObservedAt,
            observed?.economics ?? data.profile?.observedAt ?? null,
            observed?.hourly ?? data.profile?.observedAt ?? null,
            ALGORITHM_VERSION,
            data.payload!.referenceCapitalUsd,
          ],
        );
      }
      const window = dailyWindow(this.clock());
      const winner =
        data.payload && !data.payload.sample.degraded
          ? pickHighestAprPreset(data.payload.presets)
          : null;
      const eligible =
        window.eligible &&
        winner?.estimate.status === "ok" &&
        freshProfile &&
        data.profile!.windowEndUtc === volumeWindowEnd(this.clock()) &&
        this.clock() - Date.parse(data.profile!.observedAt) <= 1_800_000 &&
        !!data.chainObservedAt &&
        Date.parse(data.chainObservedAt) >= window.start;
      if (eligible && data.payload && winner?.estimate.status === "ok") {
        await this.q(
          tx,
          `UPDATE rwa_apr_daily d SET status='ok',captured_at=$3,finalized_at=clock_timestamp(),
          highest_range_apr_pct=$4,highest_range_id=$5,tick_lower=$6,tick_upper=$7,price_lower=$8,price_upper=$9,
          presets=$10::text::jsonb,reference_capital_usd=$11,chain_observed_at=$12,economics_observed_at=$13,
          volume_observed_at=$14,sample=$15::text::jsonb,failure_reason=NULL FROM rwa_pool_latest p
          WHERE d.pool_address=$1 AND d.snapshot_date=$2::date AND d.status='pending'
          AND p.pool_address=d.pool_address AND p.metrics_observed_at>$16::timestamptz`,
          [
            data.poolId,
            window.date,
            data.payload.fetchedAt,
            winner.estimate.aprPct,
            winner.id,
            winner.tickLower,
            winner.tickUpper,
            winner.priceLower,
            winner.priceUpper,
            json(data.payload.presets),
            data.payload.referenceCapitalUsd,
            data.chainObservedAt,
            observed?.economics ?? data.profile!.observedAt,
            observed?.hourly ?? data.profile!.observedAt,
            json(data.payload.sample),
            new Date(this.clock() - 1_800_000).toISOString(),
          ],
        );
      } else if (window.eligible && status !== "ok") {
        await this.q(
          tx,
          `UPDATE rwa_apr_daily SET failure_reason=$3 WHERE pool_address=$1 AND snapshot_date=$2::date AND status='pending'`,
          [
            data.poolId,
            window.date,
            `${status}:${data.issues.join("; ").slice(0, 400)}`,
          ],
        );
      }
      return { poolId: data.poolId, status };
    });
  }
}
