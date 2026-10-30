import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { assertMeteoraPending, METEORA_PENDING_KEY, meteoraPendingKey, parseMeteoraPending,
  readMeteoraPendingRaw, writeMeteoraPending, type MeteoraPending } from "./pending";

const wallet = bs58.encode(new Uint8Array(32).fill(1));
const other = bs58.encode(new Uint8Array(32).fill(2));
const base: MeteoraPending = { wallet, poolId: other, position: other, inputMint: other, lowerBinId: -5, upperBinId: 5,
  amount: "100", stage: "setup_submitted", setupSignature: bs58.encode(new Uint8Array(64).fill(3)), setupLastValidBlockHeight: 10 };
const raw = JSON.stringify(base);
const key = meteoraPendingKey(wallet);
function fixture(entries: [string, string][] = []) {
  const data = new Map(entries);
  const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }) };
  return { data, storage };
}
describe("durable Meteora pending records", () => {
  it("migrates matching legacy only after writing and reading back the scoped record", () => {
    const { data, storage } = fixture([[METEORA_PENDING_KEY, raw]]);
    expect(readMeteoraPendingRaw(wallet, storage)).toBe(raw);
    const next: MeteoraPending = { ...base, stage: "setup_confirmed" };
    storage.removeItem.mockImplementation(k => {
      expect(data.get(key)).toBe(JSON.stringify(next));
      expect(storage.getItem).toHaveBeenCalledWith(key);
      data.delete(k);
    });
    writeMeteoraPending(wallet, next, base, storage);
    expect(data.has(METEORA_PENDING_KEY)).toBe(false);
    expect(readMeteoraPendingRaw(wallet, storage)).toBe(JSON.stringify(next));
  });
  it("keeps another wallet's legacy record through write and removal", () => {
    const legacy = JSON.stringify({ ...base, wallet: other });
    const { data, storage } = fixture([[METEORA_PENDING_KEY, legacy]]);
    expect(readMeteoraPendingRaw(wallet, storage)).toBeNull();
    writeMeteoraPending(wallet, base, null, storage);
    writeMeteoraPending(wallet, null, base, storage);
    expect([...data]).toEqual([[METEORA_PENDING_KEY, legacy]]);
  });
  it.each(["{bad", JSON.stringify({ ...base, amount: "0" })])("preserves malformed legacy and blocks replacement: %s", legacy => {
    const { data, storage } = fixture([[METEORA_PENDING_KEY, legacy]]);
    expect(() => writeMeteoraPending(wallet, base, null, storage)).toThrow(/Unable to verify/);
    expect([...data]).toEqual([[METEORA_PENDING_KEY, legacy]]);
  });
  it("blocks conflicting scoped and legacy records", () => {
    const { storage } = fixture([[key, raw], [METEORA_PENDING_KEY, JSON.stringify({ ...base, amount: "200" })]]);
    expect(() => readMeteoraPendingRaw(wallet, storage)).toThrow();
    expect(() => writeMeteoraPending(wallet, null, base, storage)).toThrow();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(["throw", "drop", "corrupt"])("retains legacy when write/readback fails: %s", mode => {
    const { data, storage } = fixture([[METEORA_PENDING_KEY, raw]]);
    storage.setItem.mockImplementation(k => {
      if (mode === "throw") throw new Error("quota");
      if (mode === "corrupt") data.set(k, "{bad");
    });
    expect(() => writeMeteoraPending(wallet, { ...base, stage: "setup_confirmed" }, base, storage)).toThrow();
    expect(data.get(METEORA_PENDING_KEY)).toBe(raw);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it("detects silently dropped removal and preserves pending", () => {
    const { data, storage } = fixture([[key, raw]]);
    storage.removeItem.mockImplementation(() => {});
    expect(() => writeMeteoraPending(wallet, null, base, storage)).toThrow();
    expect(data.get(key)).toBe(raw);
  });
  it("cannot replace a newer record with an older operation's result", () => {
    const newer = JSON.stringify({ ...base, amount: "200" });
    const { data, storage } = fixture([[key, newer]]);
    expect(() => assertMeteoraPending(wallet, base, storage)).toThrow();
    expect(() => writeMeteoraPending(wallet, null, base, storage)).toThrow();
    expect(data.get(key)).toBe(newer);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("reads incomplete legacy submissions for investigation, but cannot create a new incomplete one", () => {
    const legacy = { ...base, setupSignature: undefined, setupLastValidBlockHeight: undefined };
    expect(parseMeteoraPending(JSON.stringify(legacy))).toEqual(legacy);
    const { storage } = fixture();
    expect(() => writeMeteoraPending(wallet, legacy, null, storage)).toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it.each([{ lowerBinId: 10, upperBinId: 0 }, { upperBinId: 65 }, { setupSignature: "1" },
    { wallet: "1" }, { setupLastValidBlockHeight: 0 }, { amount: "1.5" }])("rejects invalid record fields: %j", change => {
    expect(parseMeteoraPending(JSON.stringify({ ...base, ...change })) ).toBeNull();
  });
});
