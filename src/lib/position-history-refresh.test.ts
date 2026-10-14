// @vitest-environment happy-dom
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPositionHistoryRefresh, notifyPositionHistoryChange, POSITION_HISTORY_REFRESH_STORAGE_KEY,
  readPositionHistoryRefresh, subscribePositionHistoryRefresh } from "./position-history-refresh";
const mint = "11111111111111111111111111111111";
const otherMint = "22222222222222222222222222222222";
const signature = (id: number) => bs58.encode(Buffer.alloc(64, id));
beforeEach(() => window.localStorage.clear());

describe("position history browser refresh markers", () => {
  it("persists several required signatures and deduplicates notifications", () => {
    const listener = vi.fn();
    const dispose = subscribePositionHistoryRefresh(mint, listener);
    notifyPositionHistoryChange(mint, signature(1));
    const initial = readPositionHistoryRefresh(mint)!;
    notifyPositionHistoryChange(mint, signature(1));
    expect(readPositionHistoryRefresh(mint)).toEqual(initial);
    expect(listener).toHaveBeenCalledTimes(1);
    notifyPositionHistoryChange(mint, signature(2));
    expect(readPositionHistoryRefresh(mint)?.signatures).toEqual([signature(1), signature(2)]);
    expect(JSON.parse(window.localStorage.getItem(POSITION_HISTORY_REFRESH_STORAGE_KEY)!)).toHaveLength(1);
    dispose();
  });

  it("cannot clear a newer trade with an older response", () => {
    notifyPositionHistoryChange(mint, signature(1));
    const old = readPositionHistoryRefresh(mint)!;
    notifyPositionHistoryChange(mint, signature(2));
    expect(clearPositionHistoryRefresh(mint, old.version)).toBe(false);
    const latest = readPositionHistoryRefresh(mint)!;
    expect(clearPositionHistoryRefresh(mint, latest.version)).toBe(true);
    expect(readPositionHistoryRefresh(mint)).toBeNull();
  });

  it("supports force-only broadcasts/recovery without discarding required signatures", () => {
    notifyPositionHistoryChange(mint);
    expect(readPositionHistoryRefresh(mint)?.signatures).toEqual([]);
    notifyPositionHistoryChange(mint, signature(1));
    notifyPositionHistoryChange(mint);
    expect(readPositionHistoryRefresh(mint)?.signatures).toEqual([signature(1)]);
  });

  it("reads markers after module reload and limits retained positions/signatures", async () => {
    for (let id = 1; id <= 10; id++) notifyPositionHistoryChange(mint, signature(id));
    expect(readPositionHistoryRefresh(mint)?.signatures).toEqual(Array.from({ length: 8 }, (_, index) => signature(index + 3)));
    vi.resetModules();
    const reloaded = await import("./position-history-refresh");
    expect(reloaded.readPositionHistoryRefresh(mint)?.signatures).toHaveLength(8);
    for (let id = 1; id <= 70; id++) {
      const bytes = Buffer.alloc(32, 1); bytes.writeUInt32BE(id, 28);
      notifyPositionHistoryChange(bs58.encode(bytes));
    }
    expect(JSON.parse(window.localStorage.getItem(POSITION_HISTORY_REFRESH_STORAGE_KEY)!)).toHaveLength(64);
  });

  it("notifies only the affected position for same-tab and cross-tab changes", () => {
    const listener = vi.fn();
    const dispose = subscribePositionHistoryRefresh(mint, listener);
    notifyPositionHistoryChange(otherMint);
    expect(listener).not.toHaveBeenCalled();
    const value = JSON.stringify([{ positionMint: mint, signatures: [signature(1)], version: "other-tab" }]);
    window.localStorage.setItem(POSITION_HISTORY_REFRESH_STORAGE_KEY, value);
    window.dispatchEvent(new StorageEvent("storage", { key: POSITION_HISTORY_REFRESH_STORAGE_KEY, oldValue: "[]", newValue: value }));
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    notifyPositionHistoryChange(mint, signature(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed storage and invalid markers", () => {
    window.localStorage.setItem(POSITION_HISTORY_REFRESH_STORAGE_KEY, "{invalid");
    expect(readPositionHistoryRefresh(mint)).toBeNull();
    notifyPositionHistoryChange("invalid", signature(1));
    notifyPositionHistoryChange(mint, "invalid");
    expect(readPositionHistoryRefresh(mint)).toBeNull();
  });

  it("keeps a failed write authoritative when reads still return old storage and recovers without weakening CAS", () => {
    notifyPositionHistoryChange(mint, signature(1));
    const old = readPositionHistoryRefresh(mint)!;
    const oldStored = window.localStorage.getItem(POSITION_HISTORY_REFRESH_STORAGE_KEY);
    const writes = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    try {
      notifyPositionHistoryChange(mint, signature(2));
      expect(window.localStorage.getItem(POSITION_HISTORY_REFRESH_STORAGE_KEY)).toBe(oldStored);
      const newer = readPositionHistoryRefresh(mint)!;
      expect(newer.signatures).toEqual([signature(1), signature(2)]);
      expect(newer.version).not.toBe(old.version);
      expect(clearPositionHistoryRefresh(mint, old.version)).toBe(false);
      expect(readPositionHistoryRefresh(mint)).toEqual(newer);
      writes.mockRestore();
      expect(readPositionHistoryRefresh(mint)).toEqual(newer);
      expect(JSON.parse(window.localStorage.getItem(POSITION_HISTORY_REFRESH_STORAGE_KEY)!)[0].version).toBe(newer.version);
      expect(clearPositionHistoryRefresh(mint, newer.version)).toBe(true);
      expect(readPositionHistoryRefresh(mint)).toBeNull();
    } finally {
      writes.mockRestore();
      readPositionHistoryRefresh(mint);
    }
  });
});
