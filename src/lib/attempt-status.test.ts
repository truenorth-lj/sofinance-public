import { describe, expect, it } from "vitest";
import { confirmedAtomicSuccess, instructionLiquidity, mayStartAnotherAttempt } from "./attempt-status";

describe("selected transaction recovery", () => {
  it("blocks another spend while a signature may still land", () => {
    expect(mayStartAnotherAttempt("pending")).toBe(false);
    expect(mayStartAnotherAttempt("manual-review")).toBe(false);
    expect(mayStartAnotherAttempt("expired")).toBe(true);
    expect(mayStartAnotherAttempt("failed")).toBe(true);
    expect(mayStartAnotherAttempt("success")).toBe(true);
  });

  it("requires the signed exact-position instruction and its actual liquidity delta", () => {
    const record = { signedByWallet: true, addedToExactPosition: true, ownsNft: true,
      startingLiquidity: "100", expectedLiquidity: "20", currentLiquidity: "120", transactionLiquidity: 20n };
    expect(confirmedAtomicSuccess(record)).toBe(true);
    expect(confirmedAtomicSuccess({ ...record, addedToExactPosition: false })).toBe(false);
    expect(confirmedAtomicSuccess({ ...record, signedByWallet: false })).toBe(false);
    expect(confirmedAtomicSuccess({ ...record, currentLiquidity: "119" })).toBe(false);
    expect(confirmedAtomicSuccess({ ...record, transactionLiquidity: 19n })).toBe(false);
  });

  it("reads exact u128 liquidity from a Raydium increase instruction", () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(8, 5n, true);
    view.setBigUint64(16, 2n, true);
    expect(instructionLiquidity(bytes)).toBe((2n << 64n) + 5n);
    expect(instructionLiquidity(bytes.subarray(0, 23))).toBeNull();
  });
});
