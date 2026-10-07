import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { readRecentBlockTime } from "./block-time";

function connection(times: Record<number, number | null | Error>, confirmedSlot = 100) {
  return {
    getSlot: vi.fn(async () => confirmedSlot),
    getBlockTime: vi.fn(async (slot: number) => {
      const value = times[slot];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`failed to get block time for slot ${slot}: Block not available for slot ${slot}`);
      return value;
    }),
  } as unknown as Connection;
}

describe("readRecentBlockTime", () => {
  it("returns the confirmed slot when that block exists", async () => {
    const rpc = connection({ 100: 1_700_000_000 });
    await expect(readRecentBlockTime(rpc, 100)).resolves.toBe(1_700_000_000);
    expect(rpc.getBlockTime).toHaveBeenCalledOnce();
    expect(rpc.getBlockTime).toHaveBeenCalledWith(100);
  });

  it("walks back skipped tip slots instead of throwing Block not available", async () => {
    const rpc = connection({
      100: new Error("failed to get block time for slot 100: Block not available for slot 100"),
      99: null,
      98: 1_700_000_010,
    });
    await expect(readRecentBlockTime(rpc, 100)).resolves.toBe(1_700_000_010);
    expect(rpc.getSlot).not.toHaveBeenCalled();
  });

  it("reads confirmed slot when the caller omitted it, and returns null if none are available", async () => {
    const rpc = connection({}, 50);
    await expect(readRecentBlockTime(rpc)).resolves.toBeNull();
    expect(rpc.getSlot).toHaveBeenCalledWith("confirmed");
    expect(rpc.getBlockTime).toHaveBeenCalled();
  });
});
