import { expect, it, vi } from "vitest";
import { withTransientRetry } from "./retry";
it("retries a transient re-simulation mismatch and returns the fresh build", async () => {
    const build = vi.fn().mockRejectedValueOnce(new Error("Withdrawal received below simulated minimum")).mockResolvedValue("ok");
    await expect(withTransientRetry(build)).resolves.toBe("ok");
    expect(build).toHaveBeenCalledTimes(2);
});
it("does not retry other errors and gives up after the attempt limit", async () => {
    const other = vi.fn().mockRejectedValue(new Error("Price impact too high"));
    await expect(withTransientRetry(other)).rejects.toThrow("Price impact too high");
    expect(other).toHaveBeenCalledTimes(1);
    const always = vi.fn().mockRejectedValue(new Error("Wallet token balance changed; prepare again"));
    await expect(withTransientRetry(always)).rejects.toThrow("balance changed");
    expect(always).toHaveBeenCalledTimes(3);
    const fee = vi.fn().mockRejectedValueOnce(new Error("Cannot calculate transaction network cost")).mockResolvedValue("ok");
    await expect(withTransientRetry(fee)).resolves.toBe("ok");
    expect(fee).toHaveBeenCalledTimes(2);
});
