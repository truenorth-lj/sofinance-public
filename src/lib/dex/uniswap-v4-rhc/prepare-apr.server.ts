import "server-only";
import { prepareRhcRun } from "./apr-refresh.server";
import type { NativeAprRun, NativeAprRunInput } from "../apr-refresh";

/** Keep native pool specs private; queue callbacks share the original run's live issues and counters. */
export async function prepareNativeRhcAprRun(input: NativeAprRunInput): Promise<NativeAprRun> {
  const run = await prepareRhcRun(input);
  return {
    pools: run.pools.map(({ spec, poolId, refreshedAt }) => ({ poolId, refreshedAt,
      refresh: async () => {
        const outcome = await run.refreshPool(spec);
        return { outcome: outcome === "saved" ? "fresh" : outcome === "failed" ? "error" : outcome, issue: null };
      },
    })),
    issues: run.issues, stats: run.stats,
  };
}
