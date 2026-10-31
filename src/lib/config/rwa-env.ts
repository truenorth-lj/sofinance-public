import "server-only";
import { getRwaExpectedRole } from "./rwa-database-env";
/** Server-only RWA configuration. No credentials are returned to public APIs. */
export function getRwaConfig() {
  const storeMode = process.env.SOFINANCE_RWA_STORE_MODE || "gateway";
  if (storeMode !== "gateway" && storeMode !== "neon") throw new Error("Invalid RWA store mode");
  const databaseUrl = process.env.DATABASE_URL;
  const gatewayUrl = process.env.SOFINANCE_RWA_GATEWAY_URL;
  const secret = process.env.CRON_SECRET;
  const number = (
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) => {
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error("Invalid RWA configuration");
    return value;
  };
  const jobTimeoutMs = number(
    process.env.SOFINANCE_RWA_JOB_TIMEOUT_MS,
    90_000,
    10_000,
    120_000,
  );
  // The APR job (one oldest-first queue of Solana + RHC pools on one GeckoTerminal limit) gets more time than
  // discovery; the refresh still clamps it to what is left of its 80% share of the route's maxDuration (`runJob`).
  const aprJobTimeoutMs = number(
    process.env.SOFINANCE_RWA_APR_JOB_TIMEOUT_MS,
    180_000,
    10_000,
    240_000,
  );
  const leaseMs = number(
    process.env.SOFINANCE_RWA_JOB_LEASE_MS,
    120_000,
    30_000,
    240_000,
  );
  if (leaseMs < jobTimeoutMs + 20_000)
    throw new Error("RWA lease must outlive the job deadline");
  // The APR job renews its lease after its prepare phase and before every pool (`refreshAprPools`), so the lease
  // must outlive the longest unrenewed stretch (one pool ≤ ~32 s, prepare ≤ ~30 s), not `aprJobTimeoutMs` itself.
  if (leaseMs < 60_000 + 20_000)
    throw new Error("RWA lease must outlive one APR job step");
  return {
    databaseUrl,
    storeMode,
    expectedRole: getRwaExpectedRole(),
    nativeCronEnabled: process.env.SOFINANCE_RWA_NATIVE_CRON_ENABLED === "true",
    gatewayUrl,
    secret,
    enabled: process.env.SOFINANCE_RWA_DB_ENABLED === "true",
    positionHistoryEnabled: process.env.SOFINANCE_POSITION_HISTORY_DB_ENABLED === "true",
    refreshEnabled: process.env.SOFINANCE_RWA_REFRESH_ENABLED === "true",
    isVercel: !!process.env.VERCEL,
    isPreview:
      !!process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production",
    poolMax: number(process.env.SOFINANCE_RWA_DB_POOL_MAX, 3, 1, 10),
    connectTimeoutMs: number(
      process.env.SOFINANCE_RWA_DB_CONNECT_TIMEOUT_MS,
      5000,
      1000,
      15_000,
    ),
    queryTimeoutMs: number(
      process.env.SOFINANCE_RWA_DB_QUERY_TIMEOUT_MS,
      5000,
      1000,
      15_000,
    ),
    discoveryIntervalMs: number(
      process.env.SOFINANCE_RWA_DISCOVERY_INTERVAL_MS,
      900_000,
      60_000,
      3_600_000,
    ),
    aprIntervalMs: number(
      process.env.SOFINANCE_RWA_APR_INTERVAL_MS,
      300_000,
      60_000,
      3_600_000,
    ),
    profileTtlMs: number(
      process.env.SOFINANCE_RWA_PROFILE_TTL_MS,
      1_800_000,
      60_000,
      3_600_000,
    ),
    maxPages: number(process.env.SOFINANCE_RWA_MAX_PAGES, 10, 1, 30),
    concurrency: number(process.env.SOFINANCE_RWA_POOL_CONCURRENCY, 2, 1, 2),
    jobTimeoutMs,
    aprJobTimeoutMs,
    leaseMs,
  };
}

/**
 * Default tick for the self-hosted scheduler: 15 minutes. Each tick is one
 * function invocation, so the tick (not the DB job cadence) bounds Fluid Active
 * CPU. Production on Vercel uses the 4-hourly cron instead (`RWA_REFRESH_CRON`,
 * minute 15 every 4 h UTC); the range-APR UI says "Data delayed" after
 * `APR_SNAPSHOT_MAX_AGE_MS` (26 h), and each pool's daily history row is written by
 * its first successful refresh of the Taipei day.
 */
export const DEFAULT_RWA_SCHEDULER_INTERVAL_MS = 900_000;

export function rwaSchedulerIntervalMs(raw: string | undefined) {
  if (!raw) return DEFAULT_RWA_SCHEDULER_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 30_000 || value > 3_600_000)
    throw new Error("Invalid RWA configuration");
  return value;
}

export function getRwaServiceConfig() {
  return {
    port: Number(process.env.PORT || 3000),
    refreshUrl: process.env.SOFINANCE_RWA_REFRESH_URL,
    schedulerEnabled: process.env.SOFINANCE_RWA_SCHEDULER_ENABLED === "true",
    schedulerIntervalMs: rwaSchedulerIntervalMs(
      process.env.SOFINANCE_RWA_SCHEDULER_INTERVAL_MS,
    ),
  };
}
