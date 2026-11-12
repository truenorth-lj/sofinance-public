import { describe, expect, it } from "vitest";
import { meteoraDlmmDescriptor } from "./meteora-dlmm/descriptor";
import type { DexDescriptor, DexUi } from "./types";
import { uiFor } from "./ui";
import { LEGACY_PLAN_TERMS, planPoolTerms } from "@/lib/lp-plan-pool-terms";

/** Equivalent values in docs/refactor/phase-e-dex-registry.md §2.2, plus the alias PM decision. */
const MATRIX: Record<string, Pick<DexUi, "openUi" | "useDescriptorPlanTerms">> = {
  "meteora-dlmm": { openUi: "registry", useDescriptorPlanTerms: true },
  "raydium-clmm": { openUi: "native-modal", useDescriptorPlanTerms: false },
  "uniswap-v4-rhc": { openUi: "rhc-dialog", useDescriptorPlanTerms: false },
  "orca-whirlpool": { openUi: "none", useDescriptorPlanTerms: false },
  // TODO(PR11): retire/normalize this alias in E2; until then it stays none, not rhc-dialog.
  "rhc-uniswap-v4": { openUi: "none", useDescriptorPlanTerms: false },
};

describe("uiFor (E-move registry UI)", () => {
  it("matches the §2.2 matrix for every shipped protocol and the legacy alias", () => {
    for (const [id, expected] of Object.entries(MATRIX)) {
      expect(uiFor(id), id).toMatchObject(expected);
    }
  });

  it("Raydium keeps its Plan fallback and external URL; Meteora uses descriptor.ui, not the table", () => {
    expect(uiFor("raydium-clmm").planFallback).toBeTruthy();
    expect(uiFor("raydium-clmm").externalPoolUrl?.("pool1")).toBe("https://raydium.io/clmm/create-position/?pool_id=pool1");
    expect(uiFor("meteora-dlmm").externalPoolUrl).toBeUndefined();
    expect(uiFor("meteora-dlmm").planFallback).toBeUndefined();
    expect(meteoraDlmmDescriptor.ui).toEqual({ openUi: "registry", useDescriptorPlanTerms: true });
  });

  it("unknown ids default to none / legacy plan terms", () => {
    expect(uiFor("not-a-dex")).toEqual({ openUi: "none", useDescriptorPlanTerms: false });
  });

  it("a descriptor with ui.useDescriptorPlanTerms false keeps LEGACY terms", () => {
    const legacyUi: DexUi = { openUi: "registry", useDescriptorPlanTerms: false };
    const descriptor: DexDescriptor = { ...meteoraDlmmDescriptor, ui: legacyUi };
    const ui = uiFor("meteora-dlmm", { descriptorFor: () => descriptor });
    expect(ui.useDescriptorPlanTerms).toBe(false);
    const terms = planPoolTerms({
      descriptor,
      useDescriptorPlanTerms: ui.useDescriptorPlanTerms,
      listOpenReason: null,
    });
    expect(terms.openCost.bps).toBe(LEGACY_PLAN_TERMS.openCost.bps);
    expect(terms.lpFeeShare).toBe(LEGACY_PLAN_TERMS.lpFeeShare);
    expect(terms.exits).toEqual(LEGACY_PLAN_TERMS.exits);
    // The real Meteora descriptor still uses descriptor terms.
    expect(planPoolTerms({
      descriptor: meteoraDlmmDescriptor,
      useDescriptorPlanTerms: uiFor("meteora-dlmm").useDescriptorPlanTerms,
      listOpenReason: null,
    }).openCost.bps).toBe(110);
  });
});
