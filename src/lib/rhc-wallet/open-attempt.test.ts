// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRhcOpenAttempt, clearRhcOpenAttempt, parseRhcOpenAttempt, readRhcOpenAttempt,
  reconcileRhcOpenAttempt, rhcOpenAttemptKey, writeRhcOpenAttempt, type RhcOpenAttempt } from "./open-attempt";
const wallet = `0x${"22".repeat(20)}`, hash = `0x${"33".repeat(32)}`;
const attempt: RhcOpenAttempt = { version: 1, id: "request-1", wallet, poolId: `0x${"44".repeat(32)}`, kind: "execute", hash, createdAt: 1 };
beforeEach(() => {
  const records = new Map<string, string>();
  const storage: Storage = {
    get length() { return records.size; }, key: index => [...records.keys()][index] ?? null,
    getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); },
    removeItem: key => { records.delete(key); }, clear: () => records.clear(),
  };
  vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("durable RHC open history", () => {
  it("normalizes wallet keys and does not expire pending by browser time", () => {
    writeRhcOpenAttempt(attempt, null);
    expect(readRhcOpenAttempt(wallet.toUpperCase().replace("0X", "0x"))).toEqual(attempt);
    expect(readRhcOpenAttempt(`0x${"55".repeat(20)}`)).toBeNull();
  });
  it.each(["{broken", JSON.stringify({ ...attempt, hash: "0xgarbled" }), JSON.stringify({ ...attempt, wallet: "wrong" })])("preserves invalid storage", raw => {
    localStorage.setItem(rhcOpenAttemptKey(wallet), raw);
    expect(() => readRhcOpenAttempt(wallet)).toThrow("Unable to verify");
    expect(localStorage.getItem(rhcOpenAttemptKey(wallet))).toBe(raw);
  });
  it("refuses to update or clear a different attempt", () => {
    writeRhcOpenAttempt(attempt, null);
    const stale = { ...attempt, id: "old-request" };
    expect(() => clearRhcOpenAttempt(stale)).toThrow("Unable to verify");
    expect(() => writeRhcOpenAttempt({ ...stale, hash }, stale)).toThrow("Unable to verify");
    expect(readRhcOpenAttempt(wallet)).toEqual(attempt);
  });
  it("retains unknown intent if saving the returned hash fails", () => {
    const intent = { ...attempt, hash: null }; writeRhcOpenAttempt(intent, null);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {});
    expect(() => writeRhcOpenAttempt(attempt, intent)).toThrow("Unable to verify");
    expect(readRhcOpenAttempt(wallet)).toEqual(intent);
  });
  it("fails closed if removal silently fails", () => {
    writeRhcOpenAttempt(attempt, null);
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => {});
    expect(() => clearRhcOpenAttempt(attempt)).toThrow("Unable to verify");
    expect(readRhcOpenAttempt(wallet)).toEqual(attempt);
  });
  it.each([{ status: "0x1" }, { transactionHash: hash }, { transactionHash: `0x${"66".repeat(32)}`, status: "0x1" },
    { transactionHash: hash, status: "unknown" }])("does not treat an incomplete/mismatched receipt as terminal", async receipt => {
    writeRhcOpenAttempt(attempt, null);
    const provider = { request: vi.fn(async ({ method }: { method: string }) => method === "eth_chainId" ? "0x1237" : receipt) };
    await expect(reconcileRhcOpenAttempt(attempt, provider, () => true)).rejects.toThrow("Receipt is incomplete");
    expect(readRhcOpenAttempt(wallet)).toEqual(attempt);
    expect(provider.request.mock.calls.every(([a]) => ["eth_chainId", "eth_getTransactionReceipt"].includes(a.method))).toBe(true);
  });
  it("retains a newer snapshot if replaced while receipt read is in flight", async () => {
    writeRhcOpenAttempt(attempt, null);
    const newer = { ...attempt, id: "newer" };
    const provider = { request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x1237";
      localStorage.setItem(rhcOpenAttemptKey(wallet), JSON.stringify(newer));
      return { transactionHash: hash, status: "0x1" };
    }) };
    await expect(reconcileRhcOpenAttempt(attempt, provider, () => true)).rejects.toThrow("Unable to verify");
    expect(readRhcOpenAttempt(wallet)).toEqual(newer);
  });
  it("cannot query or clear a request with no known hash", async () => {
    const intent = { ...attempt, hash: null }; writeRhcOpenAttempt(intent, null);
    const provider = { request: vi.fn() };
    await expect(reconcileRhcOpenAttempt(intent, provider, () => true)).rejects.toThrow("outcome is unknown");
    expect(provider.request).not.toHaveBeenCalled(); assertRhcOpenAttempt(intent);
  });
  it("bounds a stuck provider read and keeps its attempt", async () => {
    vi.useFakeTimers(); writeRhcOpenAttempt(attempt, null);
    const provider = { request: vi.fn(() => new Promise<unknown>(() => {})) };
    const checked = expect(reconcileRhcOpenAttempt(attempt, provider, () => true, { timeoutMs: 20 })).rejects.toThrow("Switch your wallet");
    await vi.advanceTimersByTimeAsync(21); await checked;
    expect(parseRhcOpenAttempt(localStorage.getItem(rhcOpenAttemptKey(wallet)), wallet)).toEqual(attempt);
  });
});

it("does not settle a successful execute without the expected minted NFT", async () => {
  writeRhcOpenAttempt(attempt, null);
  const provider = { request: vi.fn(async ({ method }: { method: string }) => method === "eth_chainId" ? "0x1237" : { transactionHash: hash, status: "0x1", logs: [] }) };
  await expect(reconcileRhcOpenAttempt(attempt, provider, () => true)).rejects.toThrow("does not confirm the position NFT");
  expect(readRhcOpenAttempt(wallet)).toEqual(attempt);
});
