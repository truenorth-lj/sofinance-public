import { describe, expect, it, vi } from "vitest";
import { RPC_BEHIND_CODE, RPC_BEHIND_MESSAGE, RpcBehindError, withContextSlotRetry } from "./context-slot";

const behind = () => new Error("failed to simulate transaction: Minimum context slot has not been reached");
const noSleep = () => Promise.resolve();

describe("withContextSlotRetry", () => {
  it("returns the first result without waiting", async () => {
    const sleep = vi.fn(noSleep);
    await expect(withContextSlotRetry(async () => 7, { sleep })).resolves.toBe(7);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries exactly once when the node is behind, then succeeds", async () => {
    const run = vi.fn().mockRejectedValueOnce(behind()).mockResolvedValueOnce("ok");
    const sleep = vi.fn(noSleep);
    await expect(withContextSlotRetry(run, { sleep })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives a plain-language error after the single retry", async () => {
    const run = vi.fn().mockRejectedValue(behind());
    const error = await withContextSlotRetry(run, { sleep: noSleep }).catch((caught: unknown) => caught);
    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(RpcBehindError);
    expect((error as RpcBehindError).message).toBe(RPC_BEHIND_MESSAGE);
    expect((error as RpcBehindError).code).toBe(RPC_BEHIND_CODE);
    expect((error as RpcBehindError).message).not.toMatch(/context slot/i);
  });

  it("matches the JSON-RPC -32016 code", async () => {
    const coded = Object.assign(new Error("behind"), { code: -32016 });
    const run = vi.fn().mockRejectedValueOnce(coded).mockResolvedValueOnce(1);
    await expect(withContextSlotRetry(run, { sleep: noSleep })).resolves.toBe(1);
  });

  it("rethrows other errors without retrying", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Simulation failed: custom program error"));
    await expect(withContextSlotRetry(run, { sleep: noSleep })).rejects.toThrow("custom program error");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
