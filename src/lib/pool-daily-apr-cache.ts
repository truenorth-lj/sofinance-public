import type { DailyAprPoint } from "@/lib/apr-series";
import { selectBestPlanApr } from "@/lib/lp-plan-best-apr";
import { isThinPlanSample } from "@/lib/lp-plan-yield";

/**
 * A 200 with no complete day to project from (no 7 / 30 / 90-day average, or fewer days than the calculator needs, the
 * same `selectBestPlanApr` / `isThinPlanSample` checks the dialog and the homepage estimator run): kept only five
 * minutes at the CDN, so a young pool's numbers appear soon after it has one complete day.
 */
export function tooLittleData(result: { points: DailyAprPoint[]; fetchedAt: string }): boolean {
  const asOf = Date.parse(result.fetchedAt) / 1000;
  const best = selectBestPlanApr(result.points, Number.isFinite(asOf) ? asOf : undefined);
  return best === null || isThinPlanSample(best.sampleDays);
}
