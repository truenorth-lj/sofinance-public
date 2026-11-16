import "server-only";
import type { PublicClient } from "viem";
import { sanitizePublicError } from "@/lib/public-error";
import { discoverRhcRegistryPools, rhcDiscoveryFindings, type RhcDiscoveryResult } from "@/lib/pool-metrics/rhc-discovery";
import { captureRhcDiscoveryFindings } from "@/lib/sentry/capture";
import { rhcStateClient } from "@/lib/rhc-range-apr";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { resolveTokenIcons, rhcCronIconSources } from "@/lib/token-icons/resolve";
import type { CronIconInput } from "../cron-discovery";

/** Best-effort Robinhood Chain registry check for the discovery job. Never published. */
export async function inspectRhcCronPools(client: PublicClient = rhcStateClient()): Promise<RhcDiscoveryResult | { error: string }> {
  return discoverRhcRegistryPools(client)
    .then((result) => { captureRhcDiscoveryFindings(rhcDiscoveryFindings(result)); return result; })
    .catch((error) => ({ error: sanitizePublicError(error, "RHC discovery failed").slice(0, 200) }));
}

/** Fixed allowlist, DexScreener only; unlisted tokens keep their saved icons. */
export function readRhcCronIcons({ fetcher, signal }: CronIconInput) {
  return resolveTokenIcons("robinhood",
    UNIV4_RHC_ALLOWLISTED_POOLS.flatMap((pool) => [pool.currency0.address, pool.currency1.address]), rhcCronIconSources(fetcher), { signal, manual: [] });
}
