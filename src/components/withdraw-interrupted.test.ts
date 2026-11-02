import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn(), captureTxWalletErrorLanded: vi.fn() }));
import { interruptedWithdrawMessage, warnWithdrawInterrupted } from "./withdraw-panel";

afterEach(() => vi.restoreAllMocks());
describe("interrupted withdraw marker (PR10)", () => {
  it("logs one [withdraw-interrupted] line with the position and sent signatures", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnWithdrawInterrupted("mintX", ["sig1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("[withdraw-interrupted]");
    expect(JSON.parse(String(warn.mock.calls[0][1]))).toMatchObject({ positionMint: "mintX", signatures: ["sig1"] });
  });
  it("names the step that was interrupted in plain words", () => {
    expect(interruptedWithdrawMessage("withdraw")).toMatch(/after step 1 of 2: your tokens were withdrawn but not converted yet/);
    expect(interruptedWithdrawMessage("swap")).toMatch(/step 2 of 2 \(the conversion\) was confirming/);
    expect(interruptedWithdrawMessage("atomic")).toMatch(/interrupted after it was sent/);
  });
});
