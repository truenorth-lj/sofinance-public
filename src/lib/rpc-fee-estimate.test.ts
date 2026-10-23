import { describe, expect, it, vi } from "vitest";
import {
  estimateFeeForMessage, FEE_ESTIMATE_ATTEMPTS, isEmptyFeeEstimate, isTransientFeeEstimateError,
  OPEN_FEE_ESTIMATE_MESSAGE, WITHDRAW_FEE_ESTIMATE_MESSAGE, withFeeEstimateRetry,
} from "./rpc-fee-estimate";

describe("rpc fee estimate retry", () => {
  it("treats a null value as empty and retries, then uses the failover RPC", async () => {
    expect(isEmptyFeeEstimate({ value: null })).toBe(true);
    expect(isEmptyFeeEstimate({ value: 5000 })).toBe(false);
    const primary = { getFeeForMessage: vi.fn(async () => ({ value: null })) };
    const fallback = { getFeeForMessage: vi.fn(async () => ({ value: 5000 })) };
    const sleep = vi.fn(async () => undefined);
    await expect(estimateFeeForMessage(primary as never, {} as never, "confirmed", {
      fallback: () => fallback as never, sleep,
    })).resolves.toBe(5000);
    expect(primary.getFeeForMessage).toHaveBeenCalledTimes(FEE_ESTIMATE_ATTEMPTS);
    expect(fallback.getFeeForMessage).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledTimes(FEE_ESTIMATE_ATTEMPTS - 1);
  });

  it("returns the first numeric fee without a fallback call", async () => {
    const primary = { getFeeForMessage: vi.fn(async () => ({ value: 10_000 })) };
    const fallback = { getFeeForMessage: vi.fn() };
    await expect(estimateFeeForMessage(primary as never, {} as never, "confirmed", {
      fallback: () => fallback as never, sleep: async () => undefined,
    })).resolves.toBe(10_000);
    expect(fallback.getFeeForMessage).not.toHaveBeenCalled();
  });

  it("retries only the empty-fee prepare errors", async () => {
    expect(isTransientFeeEstimateError(new Error(OPEN_FEE_ESTIMATE_MESSAGE))).toBe(true);
    expect(isTransientFeeEstimateError(new Error(WITHDRAW_FEE_ESTIMATE_MESSAGE))).toBe(true);
    expect(isTransientFeeEstimateError(new Error("Quote expired"))).toBe(false);
    const run = vi.fn()
      .mockRejectedValueOnce(new Error(OPEN_FEE_ESTIMATE_MESSAGE))
      .mockResolvedValue("ok");
    await expect(withFeeEstimateRetry(run, 3, async () => undefined)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    const other = vi.fn().mockRejectedValue(new Error("simulation failed"));
    await expect(withFeeEstimateRetry(other, 3, async () => undefined)).rejects.toThrow("simulation failed");
    expect(other).toHaveBeenCalledTimes(1);
  });
});
