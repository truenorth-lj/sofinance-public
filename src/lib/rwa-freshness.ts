import type { PoolRangeAprPayload } from "./range-apr/types";
export function aprSnapshotExpired(
  payload: PoolRangeAprPayload,
  nowMs: number,
) {
  if (!payload.freshness) return false;
  const stamp = Date.parse(
    payload.freshness.chainObservedAt ?? payload.freshness.snapshotAt,
  );
  return !Number.isFinite(stamp) || nowMs - stamp > 30 * 60_000;
}
