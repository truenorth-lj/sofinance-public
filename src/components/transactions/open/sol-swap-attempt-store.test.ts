import { beforeEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { clearSolSwapAttempt, completeSolSwapAttempt, persistSolSwapAttempt, readSolSwapAttempt,
  solSwapAttemptKey, type SolSwapAttempt, type SolSwapStorage } from "./sol-swap-attempt-store";
import { solSwapReceiptKey } from "./sol-swap-receipt-store";

const wallet = testKeypair(14).publicKey.toBase58(), otherWallet = testKeypair(15).publicKey.toBase58();
const attempt: SolSwapAttempt = { version: 1, wallet, poolId: testKeypair(16).publicKey.toBase58(),
  outputMint: testKeypair(17).publicKey.toBase58(), outputSymbol: "TEST", signature: bs58.encode(new Uint8Array(64).fill(18)),
  lastValidBlockHeight: 150, createdAt: 1_700_000_000_000 };
let records: Map<string, string>, storage: SolSwapStorage;
beforeEach(() => {
  records = new Map(); storage = { getItem: key => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, value); }, removeItem: key => { records.delete(key); } };
});

describe("SOL pending storage", () => {
  it("does not expire unknown signatures by time or share them across wallets", () => {
    persistSolSwapAttempt(storage, attempt);
    expect(readSolSwapAttempt(storage, wallet)).toEqual(attempt);
    expect(readSolSwapAttempt(storage, otherWallet)).toBeNull();
  });
  it.each(["{broken", JSON.stringify({ ...attempt, wallet: otherWallet }),
    JSON.stringify({ ...attempt, lastValidBlockHeight: 0 })])("retains invalid data and fails closed", raw => {
    storage.setItem(solSwapAttemptKey(wallet), raw);
    expect(() => readSolSwapAttempt(storage, wallet)).toThrow("Unable to verify");
    expect(storage.getItem(solSwapAttemptKey(wallet))).toBe(raw);
  });
  it("does not overwrite or remove a newer attempt", () => {
    persistSolSwapAttempt(storage, attempt);
    const newer = { ...attempt, createdAt: attempt.createdAt + 1 };
    expect(() => persistSolSwapAttempt(storage, newer)).toThrow("Unable to verify");
    expect(() => clearSolSwapAttempt(storage, newer)).toThrow("Unable to verify");
    expect(readSolSwapAttempt(storage, wallet)).toEqual(attempt);
  });
  it.each(["throw", "drop", "corrupt"])("retains pending evidence when the receipt write %s fails", mode => {
    persistSolSwapAttempt(storage, attempt);
    const key = solSwapReceiptKey(wallet, attempt.poolId), write = storage.setItem;
    storage.setItem = (name, value) => {
      if (name === key) {
        if (mode === "throw") throw new Error("quota");
        if (mode === "drop") return;
        write(name, "{broken"); return;
      }
      write(name, value);
    };
    expect(() => completeSolSwapAttempt(storage, attempt, { delivered: "100", decimals: 6 })).toThrow("Unable to verify");
    expect(readSolSwapAttempt(storage, wallet)).toEqual(attempt);
  });
  it("keeps receipt evidence if pending removal fails, then preserves its open signature on recheck", () => {
    persistSolSwapAttempt(storage, attempt);
    storage.removeItem = () => { throw new Error("remove failed"); };
    expect(() => completeSolSwapAttempt(storage, attempt, { delivered: "100", decimals: 6 })).toThrow("Unable to verify");
    const key = solSwapReceiptKey(wallet, attempt.poolId);
    const receipt = { ...JSON.parse(storage.getItem(key)!), openSignature: "step-two-signature" };
    storage.setItem(key, JSON.stringify(receipt));
    storage.removeItem = name => { records.delete(name); };
    expect(completeSolSwapAttempt(storage, attempt, { delivered: "100", decimals: 6 })).toEqual(receipt);
    expect(readSolSwapAttempt(storage, wallet)).toBeNull();
  });
});
