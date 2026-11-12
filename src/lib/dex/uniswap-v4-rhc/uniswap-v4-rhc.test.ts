import { describe, expect, it } from "vitest";
import { OPEN_FEE_BPS } from "@sofinance/engine/protocols/uniswap-v4/open-constants";
import { NO_FEE } from "../types";
import { bpsFeeStrategy, feePolicyProblems } from "../fees";
import { uiFor } from "../ui";
import { UNISWAP_V4_RHC_FEE_POLICY, uniswapV4RhcDescriptor } from "./descriptor";

describe("uniswap-v4-rhc descriptor (E2-register)", () => {
  it("encodes the existing 10 bps swap-output open fee and none elsewhere; does not invent a rate", () => {
    expect(uniswapV4RhcDescriptor.meta.feePolicy).toBe(UNISWAP_V4_RHC_FEE_POLICY);
    expect(UNISWAP_V4_RHC_FEE_POLICY).toEqual({
      open: { kind: "swap-output-bps", bps: 10 },
      add: NO_FEE,
      compound: NO_FEE,
      claim: NO_FEE,
      withdrawPoolTokens: NO_FEE,
      withdrawUsdc: NO_FEE,
    });
    const openFee = UNISWAP_V4_RHC_FEE_POLICY.open;
    if (openFee.kind !== "swap-output-bps") throw new Error(`expected swap-output-bps, got ${openFee.kind}`);
    expect(openFee.bps).toBe(Number(OPEN_FEE_BPS));
    expect(feePolicyProblems(UNISWAP_V4_RHC_FEE_POLICY)).toEqual([]);
    const fees = bpsFeeStrategy(UNISWAP_V4_RHC_FEE_POLICY);
    expect(fees.feeFor("open", 10_000n)).toBe(10n);
    expect(fees.feeFor("open", 1_000_000n)).toBe(1_000n);
    for (const op of ["add", "compound", "claim", "withdrawPoolTokens", "withdrawUsdc"] as const) {
      expect(fees.feeFor(op, 1_000_000n), op).toBe(0n);
    }
  });

  it("keeps openUi rhc-dialog, useDescriptorPlanTerms false, and listPositions false", () => {
    expect(uniswapV4RhcDescriptor.id).toBe("uniswap-v4-rhc");
    expect(uniswapV4RhcDescriptor.chain).toBe("robinhood-chain");
    expect(uniswapV4RhcDescriptor.displayName).toBe("Uniswap v4");
    expect(uniswapV4RhcDescriptor.ui).toEqual({
      openUi: "rhc-dialog",
      useDescriptorPlanTerms: false,
      listPositions: false,
    });
    expect(uiFor("uniswap-v4-rhc")).toEqual({
      openUi: "rhc-dialog",
      useDescriptorPlanTerms: false,
      listPositions: false,
    });
    expect(uiFor("rhc-uniswap-v4")).toEqual({ openUi: "none", useDescriptorPlanTerms: false });
    expect(uniswapV4RhcDescriptor.capabilities.open.supported).toBe(false);
    expect(uniswapV4RhcDescriptor.capabilities.withdraw.supported).toBe(false);
    expect(uniswapV4RhcDescriptor.capabilities.plan.supported).toBe(false);
    expect(uniswapV4RhcDescriptor.capabilities.claim.supported).toBe(false);
    expect(uniswapV4RhcDescriptor.capabilities.compound.supported).toBe(false);
    expect(uniswapV4RhcDescriptor.capabilities.performance.supported).toBe(false);
    expect(uniswapV4RhcDescriptor.capabilities.deposit.supported).toBe(false);
  });
});
