import "server-only";
/** Server-only RWA configuration. No credentials are returned to public APIs. */
export function getRwaConfig() {
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
  const leaseMs = number(
    process.env.SOFINANCE_RWA_JOB_LEASE_MS,
    120_000,
    30_000,
    240_000,
  );
  if (leaseMs < jobTimeoutMs + 20_000)
    throw new Error("RWA lease must outlive the job deadline");
  return {
    databaseUrl,
    gatewayUrl,
    secret,
    enabled: process.env.SOFINANCE_RWA_DB_ENABLED === "true",
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
    leaseMs,
  };
}

export function getRwaServiceConfig() {
  return {
    port: Number(process.env.PORT || 3000),
    refreshUrl: process.env.SOFINANCE_RWA_REFRESH_URL,
    schedulerEnabled: process.env.SOFINANCE_RWA_SCHEDULER_ENABLED === "true",
  };
}
