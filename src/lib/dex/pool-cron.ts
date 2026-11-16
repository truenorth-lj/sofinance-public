import type { RwaPairRow } from "@/lib/rwa-pairs";
import type { Lease, RwaStore } from "@/lib/rwa-store-types";
import type { ThrottleGate } from "@/lib/range-apr/throttle-gate";
import type { PoolCronDiscoveryResult } from "@/lib/pool-cron-types";
export type { PoolCronDiscoveryResult };

export type PoolCronPolicy = Readonly<{ poolsPerRun: number; poolTimeoutMs: number }>;
export type PoolCronDiscoveryInput = {
  store: RwaStore; lease: Lease; seedPairs: readonly RwaPairRow[]; fetcher: typeof fetch | undefined; signal: AbortSignal;
};
export type PoolCronLaneInput = {
  store: RwaStore; lease: Lease; fetcher: typeof fetch; clock: () => number; signal: AbortSignal;
  gate: ThrottleGate; jobDeadline: number; poolTimeoutMs?: number;
};
/** Native lane statistics preserve the existing cron wire fields and stop reasons. */
export type PoolCronLaneStats = { pools: number; selected: number; done: number; stoppedBy: "datapi-429" | "time" | null; failed: number };
export type PoolCronLaneResult = { processed: number; issues: string[]; stats: PoolCronLaneStats };
export type NativePoolCron = {
  policy: PoolCronPolicy;
  publish: (input: PoolCronDiscoveryInput) => Promise<PoolCronDiscoveryResult>;
  refresh: (input: PoolCronLaneInput) => Promise<PoolCronLaneResult>;
};
