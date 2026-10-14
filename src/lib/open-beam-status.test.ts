import { describe, expect, it } from "vitest";
import { openBeamStatus } from "./open-beam-status";

const tip = { included: true, tipLamports: 100_000, tipAddress: "tip", skippedReason: null } as const;
const skipped = (skippedReason: "disabled" | "no-tip-address" | "oversize") =>
  ({ included: false, tipLamports: 0, tipAddress: null, skippedReason }) as const;

describe("openBeamStatus", () => {
  it("shows the landed label from the broadcast response", () => {
    expect(openBeamStatus(tip, " Landed via Beam · nyc · 100000 lamports ")).toEqual({
      landedLabel: "Landed via Beam · nyc · 100000 lamports", tipNote: null });
  });
  it("notes a tip without landing proof", () => {
    expect(openBeamStatus(tip, null).tipNote).toContain("landing proof not available");
  });
  it.each([
    ["oversize", "too large"], ["no-tip-address", "no Beam tip address"], ["disabled", "Beam disabled"],
  ] as const)("explains a skipped tip (%s)", (reason, text) => {
    const status = openBeamStatus(skipped(reason), null);
    expect(status.landedLabel).toBeNull();
    expect(status.tipNote).toContain(text);
  });
  it("is silent when the summary has no beam info", () => {
    expect(openBeamStatus(undefined, undefined)).toEqual({ landedLabel: null, tipNote: null });
  });
});
