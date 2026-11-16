import type { DecisionRequest } from "@/lib/lp-accounting";
import type { DecisionObservations, ReadLpExitPreview } from "@/lib/lp-plan-types";

/** Read-only native plan evidence; not new-operation preparation or generic plan rollout. */
export type LpPlanReads = {
  observations: (command: DecisionRequest, fetcher?: typeof fetch, signal?: AbortSignal) => Promise<DecisionObservations>;
  exitPreview: ReadLpExitPreview;
};
