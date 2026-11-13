import "@/lib/engine-host";
import "server-only";

import {
  RWA_REFRESH_MAX_DURATION_MS as jobMaxDurationMs,
  refreshRwaSnapshots as refreshRwaSnapshotsJob,
  runJob as runJobImpl,
  refreshTokenIcons as refreshTokenIconsImpl,
} from "./rwa-refresh/job";
import {
  APR_SAVE_RESERVE_MS as aprSaveReserveMs,
  APR_POOL_MAX_MS as aprPoolMaxMs,
  APR_QUEUE_FIXED_MS as aprQueueFixedMs,
  APR_POOLS_PER_RUN as aprPoolsPerRun,
  degradedIsSystemic as degradedIsSystemicImpl,
  activePoolRefreshedAt as activePoolRefreshedAtImpl,
  orderAprQueue as orderAprQueueImpl,
} from "./rwa-refresh/apr-queue";
import {
  METEORA_APR_POOLS_PER_RUN as meteoraAprPoolsPerRun,
  METEORA_APR_POOL_TIMEOUT_MS as meteoraAprPoolTimeoutMs,
} from "./rwa-refresh/meteora-lane";
import { refreshProfile as refreshProfileImpl } from "./rwa-refresh/solana-pool";

// Value aliases (not `export { } from`) so importers of this entry are not charged for the lane files' frozen DEX imports.
export const RWA_REFRESH_MAX_DURATION_MS = jobMaxDurationMs;
export const APR_SAVE_RESERVE_MS = aprSaveReserveMs;
export const APR_POOL_MAX_MS = aprPoolMaxMs;
export const APR_QUEUE_FIXED_MS = aprQueueFixedMs;
export const APR_POOLS_PER_RUN = aprPoolsPerRun;
export const METEORA_APR_POOLS_PER_RUN = meteoraAprPoolsPerRun;
export const METEORA_APR_POOL_TIMEOUT_MS = meteoraAprPoolTimeoutMs;

export type { Options, JobResult } from "./rwa-refresh/job";
export type { AprQueueStats } from "./rwa-refresh/apr-queue";
export type { MeteoraAprQueueStats } from "./rwa-refresh/meteora-lane";

export async function refreshRwaSnapshots(...args: Parameters<typeof refreshRwaSnapshotsJob>) {
  return refreshRwaSnapshotsJob(...args);
}
export async function runJob(...args: Parameters<typeof runJobImpl>) {
  return runJobImpl(...args);
}
export async function refreshTokenIcons(...args: Parameters<typeof refreshTokenIconsImpl>) {
  return refreshTokenIconsImpl(...args);
}
export async function refreshProfile(...args: Parameters<typeof refreshProfileImpl>) {
  return refreshProfileImpl(...args);
}
export function degradedIsSystemic(...args: Parameters<typeof degradedIsSystemicImpl>) {
  return degradedIsSystemicImpl(...args);
}
export function activePoolRefreshedAt(...args: Parameters<typeof activePoolRefreshedAtImpl>) {
  return activePoolRefreshedAtImpl(...args);
}
export function orderAprQueue<T extends { poolId: string; refreshedAt?: string | null }>(
  items: Parameters<typeof orderAprQueueImpl<T>>[0],
) {
  return orderAprQueueImpl(items);
}
