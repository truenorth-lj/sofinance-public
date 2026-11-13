import { describe, expect, it } from "vitest";
import { LEGACY_PLAN_TERMS, planPoolTerms } from "@/lib/lp-plan-pool-terms";
import { buildAndSimulateOpenPosition } from "@sofinance/engine/open-atomic";
import { getProtocolAdapter } from "@sofinance/engine/protocols/registry";
import { uiFor } from "../ui";
import { raydiumClmmDescriptor } from "./descriptor";

describe("Raydium CLMM registry UI (E3)", () => {
  it("keeps native-modal, plan fallback, external URL, and legacy plan terms", () => {
    const ui = uiFor("raydium-clmm");
    expect(ui).toMatchObject({ openUi: "native-modal", useDescriptorPlanTerms: false, listPositions: false });
    expect(ui.planFallback).toBeTruthy();
    expect(ui.externalPoolUrl?.("pool1")).toBe("https://raydium.io/clmm/create-position/?pool_id=pool1");
    expect(ui).toEqual(raydiumClmmDescriptor.ui);
    const terms = planPoolTerms({
      descriptor: raydiumClmmDescriptor,
      useDescriptorPlanTerms: ui.useDescriptorPlanTerms,
      listOpenReason: null,
    });
    expect(terms.openCost).toEqual(LEGACY_PLAN_TERMS.openCost);
    expect(terms.lpFeeShare).toEqual(LEGACY_PLAN_TERMS.lpFeeShare);
    expect(terms.exitCost).toEqual(LEGACY_PLAN_TERMS.exitCost);
  });

  it("declares the existing 10 bps swap-input fee, not a new rate, and does not invent withdraw-to-tokens fees", () => {
    const policy = raydiumClmmDescriptor.meta.feePolicy;
    expect(policy.open).toEqual({ kind: "swap-input-bps", bps: 10 });
    expect(policy.add).toEqual({ kind: "swap-input-bps", bps: 10 });
    expect(policy.compound).toEqual({ kind: "swap-input-bps", bps: 10 });
    expect(policy.withdrawUsdc).toEqual({ kind: "swap-input-bps", bps: 10 });
    expect(policy.withdrawPoolTokens).toEqual({ kind: "none" });
    expect(policy.claim).toEqual({ kind: "none" });
  });
});

describe("engine protocol adapter identity (E3)", () => {
  it("prepareOpen's builder is the original export (no wrapper)", () => {
    expect(getProtocolAdapter().buildAndSimulateOpenPosition).toBe(buildAndSimulateOpenPosition);
    expect(getProtocolAdapter("raydium-clmm").buildAndSimulateOpenPosition).toBe(buildAndSimulateOpenPosition);
  });
});
