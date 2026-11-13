/**
 * Client-safe DEX UI lookup (Phase E-move, docs/refactor/phase-e-dex-registry.md §2.2).
 *
 * Resolution: a registered descriptor's `ui` if present, else `{ openUi: "none", useDescriptorPlanTerms: false }`.
 * No stub descriptors and no invented `feePolicy`. `showHighestRange` / `nullFeeLabel` stay on
 * `CHAIN_META`.
 *
 * `normalizeDexId` maps only canonical ids; unknown spellings receive DEFAULT_UI.
 */
import { DEX_DESCRIPTORS } from "./descriptors";
import { normalizeDexId, type DexUi } from "./types";

export type { DexOpenUi, DexUi } from "./types";

const DEFAULT_UI: DexUi = Object.freeze({ openUi: "none", useDescriptorPlanTerms: false });

export type UiForDeps = {
  descriptorFor?: (id: string) => { ui?: DexUi } | null;
};

function defaultDescriptorFor(id: string) {
  const canonical = normalizeDexId(id);
  return canonical ? DEX_DESCRIPTORS.find((descriptor) => descriptor.id === canonical) ?? null : null;
}

/** UI record for a canonical DEX id; unknown spellings receive DEFAULT_UI. */
export function uiFor(protocol: string, deps: UiForDeps = {}): DexUi {
  const canonical = normalizeDexId(protocol);
  const descriptor = (deps.descriptorFor ?? defaultDescriptorFor)(canonical ?? protocol);
  if (descriptor?.ui) return descriptor.ui;
  return DEFAULT_UI;
}
