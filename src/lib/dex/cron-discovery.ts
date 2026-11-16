import type { PublicClient } from "viem";
import type { TokenIconRow } from "@/lib/token-icons/map";
import type { CronPoolInspectionResult } from "@/lib/cron-pool-types";
export type { CronPoolInspectionResult };

/** Discovery mints are seeds; a module may instead use its own approved roster. */
export type CronIconInput = { mints: readonly string[]; fetcher: typeof fetch | undefined; signal: AbortSignal };
export type ReadCronTokenIcons = (input: CronIconInput) => Promise<TokenIconRow[]>;
/** A hidden inspection result; this binding does not publish candidates or enable trading. */
export type InspectCronPools = (client?: PublicClient) => Promise<CronPoolInspectionResult | { error: string }>;
