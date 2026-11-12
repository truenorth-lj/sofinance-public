/**
 * Client-safe DEX UI lookup (Phase E-move, docs/refactor/phase-e-dex-registry.md §2.2).
 *
 * Resolution: a registered descriptor's `ui` if present, else the registry-local table for
 * venues that do not yet have a descriptor, else `{ openUi: "none", useDescriptorPlanTerms: false }`.
 * No stub descriptors and no invented `feePolicy`. `showHighestRange` / `nullFeeLabel` stay on
 * `CHAIN_META`.
 *
 * TODO(PR11): retire/normalize the `rhc-uniswap-v4` alias in E2. Until then `uiFor` keeps it at
 * `openUi: "none"` and does not let `normalizeDexId` inherit `uniswap-v4-rhc` (or a future RHC
 * descriptor).
 */
import { SUPPORTED } from "@/lib/unified-positions/model";
import { DEX_DESCRIPTORS } from "./descriptors";
import { LEGACY_DEX_ID_ALIASES, normalizeDexId, type DexId, type DexUi } from "./types";

export type { DexOpenUi, DexUi } from "./types";

const DEFAULT_UI: DexUi = Object.freeze({ openUi: "none", useDescriptorPlanTerms: false });

/**
 * UI for venues that do not yet have a `DexDescriptor`. Meteora's and Orca's values live on
 * their `descriptor.ui`, not here.
 */
const DEX_UI_BY_ID: Readonly<Partial<Record<DexId, DexUi>>> = Object.freeze({
  "raydium-clmm": Object.freeze({
    openUi: "native-modal",
    planFallback: SUPPORTED,
    externalPoolUrl: (poolId: string) => `https://raydium.io/clmm/create-position/?pool_id=${poolId}`,
    useDescriptorPlanTerms: false,
  }),
  "uniswap-v4-rhc": Object.freeze({
    openUi: "rhc-dialog",
    useDescriptorPlanTerms: false,
  }),
});

export type UiForDeps = {
  descriptorFor?: (id: string) => { ui?: DexUi } | null;
};

function defaultDescriptorFor(id: string) {
  const canonical = normalizeDexId(id);
  return canonical ? DEX_DESCRIPTORS.find((descriptor) => descriptor.id === canonical) ?? null : null;
}

/** UI record for a canonical DEX id or the one-release `rhc-uniswap-v4` alias. */
export function uiFor(protocol: string, deps: UiForDeps = {}): DexUi {
  if (Object.hasOwn(LEGACY_DEX_ID_ALIASES, protocol)) return DEFAULT_UI;
  const descriptor = (deps.descriptorFor ?? defaultDescriptorFor)(protocol);
  if (descriptor?.ui) return descriptor.ui;
  const canonical = normalizeDexId(protocol);
  return (canonical && DEX_UI_BY_ID[canonical]) || DEFAULT_UI;
}
