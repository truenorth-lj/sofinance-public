/** Existing cron limits; separate from public discovery and generic HTTP enablement. */
export const METEORA_APR_POOLS_PER_RUN = 8;
export const METEORA_APR_POOL_TIMEOUT_MS = 10_000;
export const METEORA_CRON_POLICY = Object.freeze({ poolsPerRun: METEORA_APR_POOLS_PER_RUN, poolTimeoutMs: METEORA_APR_POOL_TIMEOUT_MS });
