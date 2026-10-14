import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { testKeypair } from "./test-support/send-fixtures";
import { abandonUnsentOpenAttempt, loadOpenAttempt, openAttemptKey, parseOpenAttempt, persistOpenAttempt, type OpenAttempt } from "./open-attempt";

const wallet = testKeypair(1).publicKey.toBase58();
const attempt: OpenAttempt = { version: 1, wallet, signature: bs58.encode(new Uint8Array(64).fill(1)),
  nftMint: testKeypair(2).publicKey.toBase58(), positionAccount: testKeypair(3).publicKey.toBase58(),
  poolId: testKeypair(4).publicKey.toBase58(), tickLower: -60, tickUpper: 60, liquidity: "100",
  blockhash: testKeypair(5).publicKey.toBase58(), lastValidBlockHeight: 100, createdAt: 1000 };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe("open-position recovery records", () => {
  it("round-trips and retains the previous signature on replacement", () => {
    const saved = storage(); persistOpenAttempt(saved, attempt);
    expect(loadOpenAttempt(saved, wallet)).toEqual({ attempt, invalid: false });
    const next = { ...attempt, signature: bs58.encode(new Uint8Array(64).fill(2)) };
    persistOpenAttempt(saved, next);
    expect(loadOpenAttempt(saved, wallet).attempt).toEqual(next);
    expect(saved.getItem(`${openAttemptKey(wallet)}:history:${attempt.signature}`)).toBe(JSON.stringify(attempt));
  });
  it.each([null, [], { ...attempt, signature: "bad" }, { ...attempt, liquidity: "0" },
    { ...attempt, wallet: testKeypair(6).publicKey.toBase58() }, { ...attempt, tickLower: 60 },
    { ...attempt, lastValidBlockHeight: 0 }])("rejects malformed or foreign-wallet input %#", value => {
    expect(parseOpenAttempt(value, wallet)).toBeNull();
  });
  it("preserves corrupt records instead of ignoring them", () => {
    const saved = storage(); saved.setItem(openAttemptKey(wallet), "broken");
    expect(loadOpenAttempt(saved, wallet)).toEqual({ attempt: null, invalid: true });
    expect(saved.getItem(openAttemptKey(wallet))).toBe("broken");
  });
  it("throws when persistence is denied or silently lost", () => {
    const saved = storage(); saved.setItem = vi.fn();
    expect(() => persistOpenAttempt(saved, attempt)).toThrow("Unable to save");
    saved.setItem = () => { throw new Error("Quota exceeded"); };
    expect(() => persistOpenAttempt(saved, attempt)).toThrow("Quota exceeded");
  });
  it("archives a definitively unsent attempt before releasing it", () => {
    const saved = storage(); persistOpenAttempt(saved, attempt); abandonUnsentOpenAttempt(saved, attempt);
    expect(loadOpenAttempt(saved, wallet)).toEqual({ attempt: null, invalid: false });
    expect(saved.getItem(`${openAttemptKey(wallet)}:unsent:${attempt.signature}`)).toBe(JSON.stringify(attempt));
  });
});
