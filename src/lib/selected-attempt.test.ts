import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { parseSelectedAttempt, persistSelectedAttempt, readSelectedHistory, selectedAttemptKey, type SelectedAttempt } from "./selected-attempt";

describe("selected transaction recovery", () => {
  it("binds a saved signature to wallet, source asset and exact position", () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const positionMint = Keypair.generate().publicKey.toBase58();
    const inputMint = Keypair.generate().publicKey.toBase58();
    const value = {
      version: 2, wallet, selection: { positionMint, inputMint, inputKind: "token" },
      poolId: Keypair.generate().publicKey.toBase58(),
      positionAccount: Keypair.generate().publicKey.toBase58(),
      signature: "1".repeat(64), createdAt: Date.now(), requested: "1000000", floorBps: 9900,
      startingBalances: { input: "2000000", a: "0", b: "0" },
      startingLiquidity: "1", expectedLiquidity: "2", blockhash: "abc", lastValidBlockHeight: 100,
    };
    expect(parseSelectedAttempt(value, wallet)).toMatchObject(value);
    expect(parseSelectedAttempt({ ...value, selection: { ...value.selection, inputMint: "bad" } }, wallet)).toBeNull();
    expect(parseSelectedAttempt(value, Keypair.generate().publicKey.toBase58())).toBeNull();
  });
});

function historyFixture() {
  const key = () => Keypair.generate().publicKey.toBase58();
  const prior: SelectedAttempt = { version: 2, wallet: key(), selection: { positionMint: key(), inputMint: key(), inputKind: "token" },
    poolId: key(), positionAccount: key(), signature: "1".repeat(64), createdAt: 1, requested: "1", floorBps: 9900,
    startingBalances: { input: "1", a: "0", b: "0" }, startingLiquidity: "1", expectedLiquidity: "1", blockhash: "block", lastValidBlockHeight: 1 };
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  return { prior, values, storage };
}

it("retains both versions when a history key already contains different data", () => {
  const { prior, storage, values } = historyFixture();
  const key = selectedAttemptKey(prior.wallet); const archive = `${key}:history:${prior.signature}`;
  storage.setItem(key, JSON.stringify(prior)); storage.setItem(archive, "existing raw record");
  persistSelectedAttempt(storage, { ...prior, signature: "2".repeat(64) });
  expect(values.get(archive)).toBe("existing raw record");
  expect(values.get(`${archive}:1`)).toBe(JSON.stringify(prior));
  expect(readSelectedHistory(storage, prior.wallet)).toEqual([prior]);
  expect(readSelectedHistory(storage, Keypair.generate().publicKey.toBase58())).toEqual([]);
});

it("preserves malformed raw receipts when creating a new signed record", () => {
  const { prior, storage, values } = historyFixture();
  storage.setItem(selectedAttemptKey(prior.wallet), "malformed old record");
  persistSelectedAttempt(storage, prior);
  expect([...values.entries()].some(([key, value]) => key.includes(":history:") && value === "malformed old record")).toBe(true);
  expect(readSelectedHistory(storage, prior.wallet)).toEqual([]);
});

it("rejects silently dropped current-record writes", () => {
  const { prior, storage } = historyFixture();
  expect(() => persistSelectedAttempt({ ...storage, setItem: () => {} }, prior)).toThrow("Unable to save transaction record");
});
