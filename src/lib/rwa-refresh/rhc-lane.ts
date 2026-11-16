import "@/lib/engine-host";
import "server-only";
import type { PublicClient } from "viem";
import { sanitizePublicError } from "../public-error";
import { prepareNativeAprRun, type NativeAprRun as RhcRun, type NativeAprRunStats as RhcAprRunStats } from "@/lib/dex";
import { inspectCronPools, type CronPoolInspectionResult as RhcDiscoveryResult } from "@/lib/dex";
import type { Lease, RwaStore } from "../rwa-store-types";
import type { ThrottleGate } from "../range-apr/throttle-gate";

/** Best-effort hidden inspection, dispatched to its native module. */
export async function discoverRhcLane(client?: PublicClient): Promise<RhcDiscoveryResult | { error: string }> {
  return inspectCronPools("uniswap-v4-rhc", client);
}

export async function prepareRhcAprLane(input: {
  store: RwaStore; lease: Lease; fetcher: typeof fetch; clock: () => number; signal: AbortSignal; gate: ThrottleGate;
}): Promise<{ rhc: RhcRun | null; issues: string[]; failed: boolean }> {
  const issues: string[] = [];
  let failed = false;
  const rhc = await prepareNativeAprRun("uniswap-v4-rhc", input).catch((error) => {
    issues.push(`RHC: ${sanitizePublicError(error, "RHC APR refresh failed").slice(0, 200)}`);
    failed = true;
    return null;
  });
  // After prepare, the RHC issues are only the market batch's HTTP errors / 429 cooldown.
  if (rhc?.issues.length) failed = true;
  return { rhc, issues, failed };
}

export type { RhcAprRunStats, RhcRun };
export type { RhcDiscoveryResult };
