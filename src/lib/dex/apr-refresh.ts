import type { NativeAprRunInput, NativeAprRunStats } from "@/lib/native-apr-types";
export type { NativeAprRunInput, NativeAprRunStats };

export type AprPoolOutcome = "fresh" | "stale" | "degraded" | "error" | "throttled";
export type AprPoolResult = { outcome: AprPoolOutcome; issue: string | null };
/** The shared queue knows only its ordering key and the protocol-owned refresh callback. */
export type PreparedAprPool = { poolId: string; refreshedAt: string | null; refresh: () => Promise<AprPoolResult> };
export type NativeAprRun = { pools: PreparedAprPool[]; issues: string[]; stats: NativeAprRunStats };
export type NativeAprRefresh = { enabled: () => boolean; prepare: (input: NativeAprRunInput) => Promise<NativeAprRun> };
