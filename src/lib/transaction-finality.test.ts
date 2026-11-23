import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
vi.mock("server-only", () => ({}));
import { fakeConnection } from "@/lib/test-support/send-fixtures";
import { isSolanaSignature, readSignatureFinality } from "./transaction-finality";

const signature = bs58.encode(new Uint8Array(64).fill(7));
const observed = (value: unknown) => fakeConnection({ getSignatureStatuses: vi.fn(async () => ({ value: [value] })) });

describe("readSignatureFinality", () => {
  it.each([
    ["finalized", { confirmationStatus: "finalized", err: null, slot: 9 }, undefined, { status: "finalized", slot: 9 }],
    ["finalized at confirmed", { confirmationStatus: "finalized", err: null, slot: 9 }, "confirmed", { status: "finalized", slot: 9 }],
    ["confirmed at finalized", { confirmationStatus: "confirmed", err: null, slot: 8 }, "finalized", { status: "pending", slot: 8 }],
    ["confirmed at confirmed", { confirmationStatus: "confirmed", err: null, slot: 8 }, "confirmed", { status: "confirmed", slot: 8 }],
    ["processed at confirmed", { confirmationStatus: "processed", err: null, slot: 7 }, "confirmed", { status: "pending", slot: 7 }],
    ["an on-chain error at any stage", { confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] }, slot: 7 }, "confirmed", { status: "failed", slot: 7 }],
  ] as const)("%s", async (_name, value, commitment, expected) => {
    const connection = observed(value);
    expect(await readSignatureFinality(connection as never, { signature, lastValidBlockHeight: 100, ...(commitment ? { commitment } : {}) })).toEqual(expected);
    expect(connection.getSignatureStatuses).toHaveBeenCalledExactlyOnceWith([signature], { searchTransactionHistory: true });
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
  });

  it("not found with a height: one block-height read decides pending vs expired (strictly greater)", async () => {
    const connection = observed(null);
    connection.getBlockHeight.mockResolvedValue(100);
    expect(await readSignatureFinality(connection as never, { signature, lastValidBlockHeight: 100 })).toEqual({ status: "pending", slot: null });
    connection.getBlockHeight.mockResolvedValue(101);
    expect(await readSignatureFinality(connection as never, { signature, lastValidBlockHeight: 100 })).toEqual({ status: "expired", slot: null });
    expect(connection.getBlockHeight).toHaveBeenCalledWith("confirmed");
    expect(connection.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("not found without a height: unknown, and no second RPC call", async () => {
    const connection = observed(null);
    expect(await readSignatureFinality(connection as never, { signature })).toEqual({ status: "unknown", slot: null });
    expect(connection.getSignatureStatuses).toHaveBeenCalledOnce();
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
  });

  it("propagates an RPC failure instead of guessing a status", async () => {
    const connection = fakeConnection({ getSignatureStatuses: vi.fn(async () => { throw new Error("rpc down"); }) });
    await expect(readSignatureFinality(connection as never, { signature })).rejects.toThrow("rpc down");
  });
});

describe("isSolanaSignature", () => {
  it("accepts 64-byte base58 only", () => {
    expect(isSolanaSignature(signature)).toBe(true);
    expect(isSolanaSignature("1".repeat(64))).toBe(true);
    expect(isSolanaSignature(bs58.encode(new Uint8Array(32).fill(7)))).toBe(false);
    expect(isSolanaSignature("0".repeat(88))).toBe(false);
    expect(isSolanaSignature("x".repeat(200))).toBe(false);
    expect(isSolanaSignature(42)).toBe(false);
  });
});
