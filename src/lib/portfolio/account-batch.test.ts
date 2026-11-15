import { describe, expect, it, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
import { batchAccountReads } from "./account-batch";
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));

describe("request-local account batches", () => {
  it("deduplicates a shared pool, preserves order, reuses tick reads and isolates commitments", async () => {
    const rpc = vi.fn(async (keys: PublicKey[]) => keys.map((address) => ({ data: Buffer.from(address.toBytes()) })));
    const connection = batchAccountReads({ getMultipleAccountsInfo: rpc } as unknown as Connection);
    const [a, b, c] = await Promise.all([connection.getAccountInfo(key(1), "confirmed"), connection.getAccountInfo(key(2), "confirmed"), connection.getAccountInfo(key(1), "confirmed")]);
    expect(a).toBe(c); expect(b!.data[0]).toBe(2);
    expect(rpc.mock.calls[0]![0].map((value) => value.toBase58())).toEqual([key(1), key(2)].map(String));
    expect(await connection.getMultipleAccountsInfo([key(2), key(1)], "confirmed")).toEqual([b, a]);
    expect(rpc).toHaveBeenCalledTimes(1);
    await connection.getAccountInfo(key(1), "finalized");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("chunks at the RPC limit and rejects every waiter on an incomplete response", async () => {
    const rpc = vi.fn(async (keys: PublicKey[]) => keys.map(() => null));
    const connection = batchAccountReads({ getMultipleAccountsInfo: rpc } as unknown as Connection);
    const accounts = await connection.getMultipleAccountsInfo(Array.from({ length: 101 }, (_, n) => key(n)), "confirmed");
    expect(accounts).toHaveLength(101); expect(rpc.mock.calls.map(([keys]) => keys.length)).toEqual([100, 1]);
    const bad = batchAccountReads({ getMultipleAccountsInfo: async () => [] } as unknown as Connection);
    const results = await Promise.allSettled([bad.getAccountInfo(key(1)), bad.getAccountInfo(key(2))]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });
});
