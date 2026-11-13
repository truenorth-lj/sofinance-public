import { describe, expect, it } from "vitest";
import { compoundActionLabel, openPositionStatusCopy, statusCopy } from "./status-copy";

describe("statusCopy", () => {
  it("returns the table entry for a known stage and the fallback otherwise", () => {
    const table = { preparing: "Preparing…", wallet: "Confirm…" };
    expect(statusCopy("preparing", table, "Ready")).toBe("Preparing…");
    expect(statusCopy("idle", table, "Ready")).toBe("Ready");
    expect(statusCopy(null, table, "Ready")).toBe("Ready");
  });
});

describe("openPositionStatusCopy", () => {
  const base = {
    submitStage: undefined as string | undefined,
    openStep: undefined as number | undefined,
    quoteLoading: false,
    hasQuote: true,
    actionBlockedReason: undefined as string | undefined,
  };

  it("uses the swap table first, with a step prefix when openStep is set", () => {
    expect(openPositionStatusCopy({ ...base, submitStage: "swap-wallet" }))
      .toBe("Sign the SOL swap in your wallet…");
    expect(openPositionStatusCopy({ ...base, submitStage: "swap-preparing", openStep: 1 }))
      .toBe("Step 1/2 · Preparing SOL swap…");
  });

  it("uses the open-step table for preparing/wallet/checking/broadcasting when openStep is set", () => {
    expect(openPositionStatusCopy({ ...base, submitStage: "wallet", openStep: 2 }))
      .toBe("Step 2/2 · Sign the open position in your wallet…");
    expect(openPositionStatusCopy({ ...base, submitStage: "pending", openStep: 2 }))
      .toBe("Waiting for on-chain confirmation…");
  });

  it("falls through to the submit table, then Fetching quote…, then the blocked reason, then Ready to sign", () => {
    expect(openPositionStatusCopy({ ...base, submitStage: "preparing" }))
      .toBe("Preparing latest transaction…");
    expect(openPositionStatusCopy({ ...base, quoteLoading: true, hasQuote: false }))
      .toBe("Fetching quote…");
    expect(openPositionStatusCopy({ ...base, actionBlockedReason: "Enter an amount to get a quote" }))
      .toBe("Enter an amount to get a quote");
    expect(openPositionStatusCopy(base)).toBe("Ready to sign");
  });
});

describe("compoundActionLabel", () => {
  const checking = "Checking Solana…";

  it("uses the cleanup table while cleanup is running", () => {
    expect(compoundActionLabel({ cleanupRunning: true, stage: "preparing", checkingCopy: checking }))
      .toBe("Preparing cleanup…");
    expect(compoundActionLabel({ cleanupRunning: true, stage: "checking", checkingCopy: checking }))
      .toBe(checking);
    expect(compoundActionLabel({ cleanupRunning: true, stage: undefined, checkingCopy: checking }))
      .toBe("Verifying cleanup…");
  });

  it("uses the compound table otherwise", () => {
    expect(compoundActionLabel({ cleanupRunning: false, stage: "wallet", checkingCopy: checking }))
      .toBe("Confirming in wallet…");
    expect(compoundActionLabel({ cleanupRunning: false, stage: undefined, checkingCopy: checking }))
      .toBe("One-click compound");
  });
});
