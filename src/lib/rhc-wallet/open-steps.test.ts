import { describe, expect, it } from "vitest";
import { openSteps, RETRY_CONFIRM_TEXT, stepProgressLabel } from "./open-steps";

describe("openSteps", () => {
  it("is Step 1/2 sign, 2/2 execute when Permit2 is already approved", () => {
    expect(openSteps(false).map(s => [s.id, stepProgressLabel(s)])).toEqual([["sign", "Step 1/2"], ["execute", "Step 2/2"]]);
  });
  it("adds the one-time unlimited Permit2 approve first", () => {
    const steps = openSteps(true);
    expect(steps.map(s => [s.id, stepProgressLabel(s)])).toEqual([["approve", "Step 1/3"], ["sign", "Step 2/3"], ["execute", "Step 3/3"]]);
    expect(steps[0]!.detail).toMatch(/unlimited approval to the Permit2 contract, done once per token/);
  });
  it("uses the PM retry wording", () => {
    expect(RETRY_CONFIRM_TEXT.zh).toBe("價格剛變動，已重新報價，請再確認一次");
  });
});
