import { dexDescriptors } from "@/lib/dex/descriptor-registry";
import { uiFor, openCapabilityFor } from "@/lib/dex/ui";
import { buildOpenPositionPath } from "@/lib/public-urls";
import { unsupportedTokenReason, type UnifiedPool } from "./model";

/**
 * What the Open control on a pool card, list row, or public pool page should do.
 */
export type OpenAction =
  | { kind: "open"; onOpen: () => void }
  | { kind: "link"; href: string }
  | { kind: "none"; reason: string }
  /** A greyed, disabled Open button with the reason shown next to it (e.g. Meteora pools). */
  | { kind: "disabled"; reason: string }
  /** The pool's tokens use a setting opening does not handle yet: a greyed "Not supported yet" with the reason as its tooltip. */
  | { kind: "unsupported"; reason: string };

/**
 * Open as on `/pools`: tokens not supported yet say so; a registry or hidden registry DEX
 * (`openUi: "registry"` or `"none"`, today Meteora and Orca) is disabled when its `open` capability is
 * unsupported. Native-modal availability follows the native capability record; other pools keep
 * their deep links. The app page resolves the same UI contract. No DEX-name checks here.
 */
export function openAction(pool: UnifiedPool): OpenAction {
  const unsupported = unsupportedTokenReason(pool);
  if (unsupported) return { kind: "unsupported", reason: unsupported };
  // Resolve the capability for the chosen UI contract. A native modal reads its
  // native declaration; generic StepResult readiness still governs registry shells.
  const openUi = uiFor(pool.protocol).openUi;
  if (openUi === "registry" || openUi === "none" || openUi === "native-modal") {
    const open = openCapabilityFor(dexDescriptors.descriptorFor(pool.protocol));
    if (open && !open.supported) return { kind: "disabled", reason: open.reason };
  }
  return { kind: "link", href: buildOpenPositionPath(pool.poolAddress) };
}
