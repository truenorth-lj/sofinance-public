import { dexDescriptors } from "@/lib/dex/descriptor-registry";
import { uiFor } from "@/lib/dex/ui";
import type { Capability } from "@/lib/unified-positions/model";
import type { UnifiedPool } from "./model";

/**
 * The plan capability that decides whether a pool card shows Calculate.
 *
 * A registered `plan` capability only drives the chip when plan terms or the open UI come from
 * the registry (`useDescriptorPlanTerms` or `openUi` registry/none). RHC keeps `rhc-dialog` and
 * `useDescriptorPlanTerms: false`, so it still uses `planFallback` (unset → no Calculate button),
 * matching the pre-register screen. Meteora (plan terms on) and Orca (`openUi: "none"`) are unchanged.
 */
export function poolPlanCapability(pool: Pick<UnifiedPool, "protocol">): Capability | null {
  const ui = uiFor(pool.protocol);
  const useRegisteredPlan = ui.useDescriptorPlanTerms || ui.openUi === "registry" || ui.openUi === "none";
  return (useRegisteredPlan ? dexDescriptors.descriptorFor(pool.protocol)?.capabilities.plan : null)
    ?? (ui.planFallback ?? null);
}

/** True when the card (and the public pool page) offer a working Calculate control. */
export function poolSupportsCalculator(pool: Pick<UnifiedPool, "protocol">): boolean {
  return poolPlanCapability(pool)?.supported === true;
}
