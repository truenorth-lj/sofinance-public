import "@/lib/engine-host";
import "server-only";
import type { PublicClient } from "viem";
import { sanitizePublicError } from "../public-error";
import { isRhcApr7dEnabled } from "../protocol-flags";
import { prepareRhcRun, type RhcAprRunStats, type RhcRun } from "../rhc-apr-refresh";
import { discoverRhcRegistryPools, rhcDiscoveryFindings, type RhcDiscoveryResult } from "../pool-metrics/rhc-discovery";
import { captureRhcDiscoveryFindings } from "../sentry/capture";
import type { Lease, RwaStore } from "../rwa-store-types";
import type { ThrottleGate } from "../range-apr/throttle-gate";

/** Best-effort Robinhood Chain registry check for the discovery job. Never published. */
export async function discoverRhcLane(client: PublicClient): Promise<RhcDiscoveryResult | { error: string }> {
  return discoverRhcRegistryPools(client)
    .then((result) => { captureRhcDiscoveryFindings(rhcDiscoveryFindings(result)); return result; })
    .catch((error) => ({ error: sanitizePublicError(error, "RHC discovery failed").slice(0, 200) }));
}

export async function prepareRhcAprLane(input: {
  store: RwaStore; lease: Lease; fetcher: typeof fetch; clock: () => number; signal: AbortSignal; gate: ThrottleGate;
}): Promise<{ rhc: RhcRun | null; issues: string[]; failed: boolean }> {
  const issues: string[] = [];
  let failed = false;
  if (!isRhcApr7dEnabled()) return { rhc: null, issues, failed };
  const rhc = await prepareRhcRun(input).catch((error) => {
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
