import { describe, expect, it, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
import { ACCOUNT_BATCH_LIMIT, batchAccountReads, withSharedAccountReads } from "./account-batch";
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
  it("chunks past the 100-key RPC limit and keeps every result in order", async () => {
    const rpc = vi.fn(async (keys: PublicKey[]) => keys.map((address) => ({ data: Buffer.from(address.toBytes()) })));
    const connection = batchAccountReads({ getMultipleAccountsInfo: rpc } as unknown as Connection);
    const keys = Array.from({ length: 250 }, (_, n) => new PublicKey(Buffer.alloc(32, n % 250).fill(n >> 8, 0, 1)));
    const accounts = await connection.getMultipleAccountsInfo(keys, "confirmed");
    expect(ACCOUNT_BATCH_LIMIT).toBe(100);
    expect(rpc.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);
    expect(accounts.map((account) => new PublicKey(account!.data).toBase58())).toEqual(keys.map(String));
  });
  it("coalesces concurrent readers whose waves land several promise hops apart (other rows, other DEXes)", async () => {
    const rpc = vi.fn(async (keys: PublicKey[]) => keys.map(() => null));
    const connection = batchAccountReads({ getMultipleAccountsInfo: rpc } as unknown as Connection);
    const hops = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    const raydium = (async () => { await connection.getAccountInfo(key(1), "confirmed"); await connection.getAccountInfo(key(3), "confirmed"); })();
    const meteora = (async () => {
      await hops(3); await connection.getMultipleAccountsInfo([key(2)], "confirmed");
      await hops(5); await connection.getMultipleAccountsInfo([key(4), key(5)], "confirmed");
    })();
    await Promise.all([raydium, meteora]);
    expect(rpc.mock.calls.map(([batch]) => batch.map(String))).toEqual([[key(1), key(2)].map(String), [key(3), key(4), key(5)].map(String)]);
  });
  it("falls back to one read per key when a batch fails or comes back partial", async () => {
    const single = vi.fn<(address: PublicKey, config?: unknown) => Promise<{ data: Buffer }>>(async (address) => ({ data: Buffer.from(address.toBytes()) }));
    for (const response of [() => Promise.reject(new Error("429")), async () => [null]]) {
      single.mockClear();
      const rpc = vi.fn(response);
      const connection = batchAccountReads({ getMultipleAccountsInfo: rpc, getAccountInfo: single } as unknown as Connection);
      const [a, b] = await Promise.all([connection.getAccountInfo(key(1), "confirmed"), connection.getAccountInfo(key(2), "confirmed")]);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(single.mock.calls.map(([address, config]) => [address.toBase58(), config])).toEqual([[key(1).toBase58(), "confirmed"], [key(2).toBase58(), "confirmed"]]);
      expect([a!.data[0], b!.data[0]]).toEqual([1, 2]);
    }
  });
  it("isolates a key whose fallback read fails and retries it on the next wave", async () => {
    let failing = true;
    const single = vi.fn(async (address: PublicKey) => {
      if (failing && address.equals(key(2))) throw new Error("bad key");
      return { data: Buffer.from(address.toBytes()) };
    });
    const rpc = vi.fn(async () => { throw new Error("batch down"); });
    const connection = batchAccountReads({ getMultipleAccountsInfo: rpc, getAccountInfo: single } as unknown as Connection);
    const [good, bad] = await Promise.allSettled([connection.getAccountInfo(key(1)), connection.getAccountInfo(key(2))]);
    expect(good.status).toBe("fulfilled"); expect(bad.status).toBe("rejected");
    failing = false;
    expect((await connection.getAccountInfo(key(2)))!.data[0]).toBe(2);
    expect((await connection.getAccountInfo(key(1)))!.data[0]).toBe(1);
    expect(single).toHaveBeenCalledTimes(3);
  });
  it("serves a row's account reads from the shared batch and keeps other methods and its deadline on the row", async () => {
    const rpc = vi.fn(async (keys: PublicKey[]) => keys.map(() => null));
    const shared = batchAccountReads({ getMultipleAccountsInfo: rpc } as unknown as Connection);
    const history = vi.fn(async () => []);
    const rowAccounts = vi.fn();
    const row = { getAccountInfo: rowAccounts, getMultipleAccountsInfo: rowAccounts, getSignaturesForAddress: history } as unknown as Connection;
    const first = withSharedAccountReads(shared, row);
    const controller = new AbortController();
    const second = withSharedAccountReads(shared, row, controller.signal);
    await Promise.all([first.getAccountInfo(key(1)), second.getMultipleAccountsInfo([key(1), key(2)])]);
    await first.getSignaturesForAddress(key(1));
    expect(rpc).toHaveBeenCalledTimes(1); expect(rowAccounts).not.toHaveBeenCalled(); expect(history).toHaveBeenCalledTimes(1);
    rpc.mockImplementation(() => new Promise(() => {}));
    const stuck = second.getAccountInfo(key(3));
    controller.abort(new Error("row deadline"));
    await expect(stuck).rejects.toThrow("row deadline");
  });
  it("fences queued and dependent account waves after transport cancellation", async () => {
    const controller = new AbortController();
    let complete!: (accounts: null[]) => void;
    const rpc = vi.fn(() => new Promise<null[]>((resolve) => { complete = resolve; }));
    const connection = batchAccountReads({ getMultipleAccountsInfo: rpc } as unknown as Connection, controller.signal);
    const dependent = connection.getAccountInfo(key(1)).then(() => connection.getAccountInfo(key(2)));
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    controller.abort(new Error("deadline"));
    complete([null]);
    await expect(dependent).rejects.toThrow("deadline");
    expect(rpc).toHaveBeenCalledTimes(1);
    const cancelled = connection.getAccountInfo(key(3));
    await expect(cancelled).rejects.toThrow("deadline"); expect(rpc).toHaveBeenCalledTimes(1);
    const queuedController = new AbortController();
    const queued = batchAccountReads({ getMultipleAccountsInfo: rpc } as unknown as Connection, queuedController.signal).getAccountInfo(key(4));
    queuedController.abort(new Error("queued deadline"));
    await expect(queued).rejects.toThrow("queued deadline"); expect(rpc).toHaveBeenCalledTimes(1);
  });

});
