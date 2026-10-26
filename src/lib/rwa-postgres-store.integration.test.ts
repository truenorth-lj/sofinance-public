/** Opt-in real SQL checks, confined to a disposable schema in the dedicated DB. */
import { readMigrationFiles } from "drizzle-orm/migrator";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 30_000 });
import { createRwaDatabase, PostgresRwaStore } from "./rwa-postgres-store";
import {
  ALGORITHM_VERSION,
  type AprWrite,
  type DiscoveryWrite,
  type Lease,
  type SnapshotApr,
  type SnapshotPairs,
} from "./rwa-store-types";
import type { RwaPairRow } from "./rwa-pairs";
import type { VolumeProfile } from "./pool-range-apr";
import { payloadFixture } from "./range-apr/payload.fixture";

const url = process.env.RWA_DB_TEST_URL;
describe.skipIf(!url)("RWA PostgreSQL snapshots and fencing", () => {
  const schema = `rwa_it_${randomUUID().replaceAll("-", "")}`;
  const db = url ? createRwaDatabase(url, schema) : null;
  let now = Date.parse("2026-10-14T00:15:00Z");
  const store = db ? new PostgresRwaStore(db, () => now) : null;
  const poolId = "1".repeat(32),
    poolB = "2".repeat(32),
    poolC = "3".repeat(32);
  let discovery: Lease, apr: Lease;
  const observed = () => new Date(now).toISOString();
  function pair(id: string): RwaPairRow {
    return {
      poolAddress: id,
      mintA: "4".repeat(32),
      mintB: "5".repeat(32),
      symbolA: "TESTx",
      symbolB: "TEST",
      tvlUsd: 1000,
      volume24hUsd: 100,
      fees24hUsd: 1,
      feeRate: 0.001,
      estimatedFeeAprPct: 36.5,
    } as RwaPairRow;
  }
  function discoveryData(ids = [poolId, poolB, poolC]): DiscoveryWrite {
    return {
      result: {
        pairs: ids.map(pair),
        pagesFetched: 2,
        scannedPools: 3,
        fetchedAt: observed(),
        source: "fixture",
        pairingRuleSummary: "fixture",
        estimatedFeeAprLabel: "fixture",
      },
      sourcePages: Object.fromEntries(
        ids.map((id, index) => [id, index ? 2 : 1]),
      ),
      poolObservedAt: Object.fromEntries(ids.map((id) => [id, observed()])),
      pageCounts: [1, 2],
      qualificationObservedAt: {},
    };
  }
  function aprData(id = poolId): AprWrite {
    const payload = payloadFixture({ poolId: id, fetchedAt: observed() });
    payload.presets = payload.presets.map((p) => ({
      ...p,
      priceLower: 0.9,
      priceUpper: 1.1,
    }));
    const profile = {
      economics: { mintA: pair(id).mintA, mintB: pair(id).mintB },
      candles: [{ timestamp: 1 }],
      stale: false,
      observedAt: {
        economics: observed(),
        daily: observed(),
        hourly: observed(),
      },
    } as unknown as VolumeProfile;
    return {
      poolId: id,
      payload,
      chainObservedAt: observed(),
      issues: [],
      profile: {
        algorithmVersion: ALGORITHM_VERSION,
        profile,
        observedAt: observed(),
        windowEndUtc: "2026-10-14T00:00:00.000Z",
      },
    };
  }
  beforeAll(async () => {
    await db!.unsafe(`CREATE SCHEMA ${schema}`);
    for (const migration of readMigrationFiles({ migrationsFolder: resolve("drizzle") }))
      for (const statement of migration.sql)
        await db!.unsafe(statement.replaceAll('"public".', `"${schema}".`));
  }, 20_000);
  afterAll(async () => {
    if (db) {
      await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  }, 20_000);

  it("admits one caller, fences an expired owner and atomically publishes a generation", async () => {
    const claims = await Promise.all([
      store!.request({ op: "claim", job: "rwa-discovery" }),
      store!.request({ op: "claim", job: "rwa-discovery" }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean) as Lease;
    await db!`UPDATE background_job_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_key='rwa-discovery'`;
    discovery = (await store!.request({
      op: "claim",
      job: "rwa-discovery",
    })) as Lease;
    expect(discovery.epoch).toBe(old.epoch + 1);
    await expect(
      store!.request({
        op: "publishDiscovery",
        lease: old,
        data: discoveryData(),
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    await store!.request({
      op: "publishDiscovery",
      lease: discovery,
      data: discoveryData(),
    });
    const first = (await store!.request({
      op: "pairs",
      minTvl: 0,
      maxPages: 1,
      sortBy: "tvl",
    })) as SnapshotPairs;
    expect(first.pairs.map((p) => p.poolAddress)).toEqual([poolId]);
    expect(first.scannedPools).toBe(1);
    await expect(
      store!.request({ op: "pairs", minTvl: 0, maxPages: 11, sortBy: "tvl" }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_COVERAGE_UNAVAILABLE" });
    const broken = discoveryData([poolId, poolB]);
    delete broken.poolObservedAt[poolB]; // Failure after the first upsert must roll it back.
    await expect(
      store!.request({
        op: "publishDiscovery",
        lease: discovery,
        data: broken,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DISCOVERY" });
    expect(
      (
        (await store!.request({
          op: "pairs",
          minTvl: 0,
          maxPages: 10,
          sortBy: "tvl",
        })) as SnapshotPairs
      ).pairs,
    ).toHaveLength(3);
    await store!.request({
      op: "finish",
      lease: discovery,
      outcome: "ok",
      processed: 3,
      issues: [],
    });
    expect(
      await store!.request({ op: "claim", job: "rwa-discovery" }),
    ).toBeNull();
    const [job] =
      await db!`SELECT last_error,last_summary,extract(epoch FROM(next_due_at-last_started_at)) AS interval FROM background_job_state WHERE job_key='rwa-discovery'`;
    expect(job!.last_error).toBeNull();
    expect(job!.last_summary.processed).toBe(3);
    expect(Number(job!.interval)).toBe(900);
  });

  it("admits within due grace, suppresses a duplicate, and recovers a missed tick without force", async () => {
    await db!`UPDATE background_job_state SET next_due_at=clock_timestamp()+interval '30 seconds' WHERE job_key='rwa-discovery'`;
    const lease = await store!.request({ op: "claim", job: "rwa-discovery" }) as Lease;
    expect(lease).not.toBeNull();
    expect(await store!.request({ op: "claim", job: "rwa-discovery" })).toBeNull();
    await db!`UPDATE background_job_state SET lease_expires_at=clock_timestamp()-interval '1 second',next_due_at=clock_timestamp()-interval '30 minutes' WHERE job_key='rwa-discovery'`;
    const recovered = await store!.request({ op: "claim", job: "rwa-discovery" }) as Lease;
    expect(recovered.epoch).toBe(lease.epoch + 1);
    await expect(store!.request({ op: "renew", lease })).rejects.toMatchObject({ code: "LEASE_LOST" });
    await store!.request({ op: "finish", lease: recovered, outcome: "ok", processed: 0, issues: [] });
  });

  it("keeps the last complete APR, persists the full model and caches profile across readers", async () => {
    apr = (await store!.request({
      op: "claim",
      job: "rwa-apr-refresh",
    })) as Lease;
    await store!.request({ op: "prepareDaily", lease: apr });
    await store!.request({ op: "saveApr", lease: apr, data: aprData() });
    const first = (await store!.request({ op: "apr", poolId })) as SnapshotApr;
    expect(first.model.bins).toHaveLength(21);
    expect(first.freshness.chainObservedAt).toBe(observed());
    await store!.request({
      op: "saveApr",
      lease: apr,
      data: {
        poolId,
        payload: null,
        profile: null,
        chainObservedAt: null,
        issues: ["upstream unavailable"],
      },
    });
    const retained = (await store!.request({
      op: "apr",
      poolId,
    })) as SnapshotApr;
    expect(retained.model).toEqual(first.model);
    expect(retained.freshness.lastAttemptStatus).toBe("error");
    const [active] = (await new PostgresRwaStore(db!, () => now).request({
      op: "activePools",
    })) as { profile: unknown }[];
    expect(active!.profile).not.toBeNull();
    await expect(
      store!.request({ op: "apr", poolId: poolB }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_UNAVAILABLE" });
  });

  it("captures one valid sample per day, never overwrites it, and finalizes failed/missing values as NULL", async () => {
    const [before] =
      await db!`SELECT highest_range_apr_pct,captured_at FROM rwa_apr_daily WHERE pool_address=${poolId}`;
    expect(before!.highest_range_apr_pct).not.toBeNull();
    now += 300_000;
    const changed = aprData();
    changed.payload!.presets.forEach((p) => {
      if (p.estimate.status === "ok") p.estimate.aprPct = 999;
    });
    await store!.request({ op: "saveApr", lease: apr, data: changed });
    const [after] =
      await db!`SELECT highest_range_apr_pct,captured_at FROM rwa_apr_daily WHERE pool_address=${poolId}`;
    expect(after).toEqual(before);
    const stale = aprData(poolB);
    stale.profile!.profile.stale = true;
    stale.payload!.sample.degraded = true;
    await store!.request({ op: "saveApr", lease: apr, data: stale });
    now = Date.parse("2026-10-14T01:10:00Z");
    await store!.request({ op: "prepareDaily", lease: apr });
    const missing =
      await db!`SELECT pool_address,status,highest_range_apr_pct FROM rwa_apr_daily ORDER BY pool_address`;
    expect(missing.map((r) => r.status)).toEqual(["ok", "degraded", "missing"]);
    expect(missing.slice(1).map((r) => r.highest_range_apr_pct)).toEqual([
      null,
      null,
    ]);
    await store!.request({ op: "saveApr", lease: apr, data: aprData(poolC) });
    const [late] =
      await db!`SELECT status,highest_range_apr_pct FROM rwa_apr_daily WHERE pool_address=${poolC}`;
    expect(late).toMatchObject({
      status: "missing",
      highest_range_apr_pct: null,
    });
    const history = (await store!.request({
      op: "history",
      poolId: poolC,
      from: "2026-10-14",
      to: "2026-10-14",
    })) as { points: { highestRangeAprPct: unknown }[] };
    expect(history.points).toHaveLength(1);
    expect(history.points[0]!.highestRangeAprPct).toBeNull();
    await store!.request({
      op: "finish",
      lease: apr,
      outcome: "partial",
      processed: 3,
      issues: ["one pool degraded"],
    });
    const [job] =
      await db!`SELECT extract(epoch FROM(next_due_at-last_started_at)) AS interval FROM background_job_state WHERE job_key='rwa-apr-refresh'`;
    expect(Number(job!.interval)).toBe(300);
  });
});
