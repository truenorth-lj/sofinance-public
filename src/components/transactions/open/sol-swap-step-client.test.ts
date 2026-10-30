import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import type { VersionedTransaction } from "@solana/web3.js";
import { buildTransaction, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { rawToDecimalString, runSolSwapStep, reconcileSolSwapStep, SolSwapStepError } from "./sol-swap-step-client";
import { readSolSwapAttempt, solSwapAttemptKey } from "./sol-swap-attempt-store";
import { solSwapReceiptKey } from "./sol-swap-receipt-store";

describe("rawToDecimalString", () => {
  it.each([
    ["24650000", 9, "0.02465"], ["1000000000", 9, "1"], ["1", 9, "0.000000001"], ["0", 6, "0"],
    ["123456789", 6, "123.456789"], ["42", 0, "42"], ["120000000000000000001", 9, "120000000000.000000001"],
  ])("%s with %d decimals is %s", (raw, decimals, expected) => {
    expect(rawToDecimalString(raw, decimals)).toBe(expected);
  });
});

const payer = testKeypair(11), wallet = payer.publicKey.toBase58();
const outputMint = testKeypair(12).publicKey.toBase58();
const poolId = testKeypair(13).publicKey.toBase58();

function setup(statuses: Array<Record<string, unknown>>, prepareOver: Record<string, unknown> = {}) {
  const tx = buildTransaction({ payer, signWith: [] });
  const summary = { operation: "sol-swap-step", wallet, poolId, requested: "1000000", outputMint, outputSymbol: "SPCX",
    blockhash: tx.message.recentBlockhash, lastValidBlockHeight: 9, expiresAt: Date.now() + 60_000, ...prepareOver };
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  const calls: string[] = [];
  let sig = "";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url === "/api/sol-swap-prepare") return Response.json({ unsignedTransaction: toBase64(tx), permit: "p", summary });
    if (url === "/api/sol-swap-broadcast") return Response.json({ signature: sig });
    if (url === "/api/sol-swap-status") return Response.json(statuses.shift() ?? { status: "pending" });
    throw new Error(`Unexpected ${url}`);
  }));
  const signTransaction = vi.fn(async (unsigned: VersionedTransaction) => {
    unsigned.sign([payer]); sig = bs58.encode(unsigned.signatures[0]!); return unsigned;
  });
  const stages: string[] = [];
  const run = (over: Partial<Parameters<typeof runSolSwapStep>[0]> = {}) => runSolSwapStep({ wallet, poolId, amount: "0.001", requested: "1000000", store: new Map() as never,
    timeoutMs: 5_000, signTransaction, setStage: s => stages.push(s), current: () => true, storage, sleep: async () => {}, ...over });
  return { run, calls, stages, signTransaction, storage, sig: () => sig };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("runSolSwapStep (step 1/2)", () => {
  it("returns the amount the confirmed swap delivered, not the quote", async () => {
    const t = setup([{ status: "pending" }, { status: "confirmed", delivered: "24650000", decimals: 9 }]);
    const receipt = await t.run();
    expect(receipt).toEqual({ wallet, poolId, signature: t.sig(), outputMint, outputSymbol: "SPCX", delivered: "24650000", decimals: 9, landedAt: expect.any(Number) });
    expect(t.stages).toEqual(["swap-preparing", "swap-wallet", "swap-broadcasting", "swap-pending"]);
    expect(t.calls.filter(u => u === "/api/sol-swap-status")).toHaveLength(2);
  });
  it.each(["failed", "expired"])("reports an on-chain %s result with the signature and clears pending", async status => {
    const t = setup([{ status }]);
    const error = await t.run().catch(e => e);
    expect(error).toBeInstanceOf(SolSwapStepError);
    expect(error.signature).toBe(t.sig());
    expect(readSolSwapAttempt(t.storage, wallet)).toBeNull();
    expect(t.storage.getItem(solSwapReceiptKey(wallet, poolId))).toBeNull();
  });
  it("refuses a prepared swap for another amount before asking the wallet", async () => {
    const t = setup([], { requested: "2000000" });
    await expect(t.run()).rejects.toThrow("Prepared SOL swap expired or incomplete");
    expect(t.signTransaction).not.toHaveBeenCalled();
  });
});
describe("review 20261030 broadcast ambiguity", () => {
  it.each(["transport", "invalid-json"])("SAFETY: %s response retains original swap signature or reconciles it", async mode => {
    const t = setup([{ status: "confirmed", delivered: "24650000", decimals: 9 }]);
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (args[0] === "/api/sol-swap-broadcast") {
        if (mode === "transport") throw new TypeError("Failed to fetch");
        return new Response("gateway lost response", { status: 502 });
      }
      return original(...args);
    });
    const outcome = await t.run().catch(error => error);
    expect(t.sig()).not.toBe("");
    expect(outcome).toMatchObject({ signature: t.sig() });
  });
});


describe("durable SOL swap admission", () => {
  it("queries its own signed transaction when the broadcast response names a different signature", async () => {
    const t = setup([{ status: "confirmed", delivered: "100", decimals: 6 }]), original = fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (args[0] === "/api/sol-swap-broadcast") return Response.json({ signature: "wrong-signature" });
      if (args[0] === "/api/sol-swap-status") expect(JSON.parse(args[1]!.body as string).signature).toBe(t.sig());
      return original(...args);
    });
    expect((await t.run()).signature).toBe(t.sig());
    expect(t.signTransaction).toHaveBeenCalledOnce();
  });
  it("persists the signature and block height before send, then hands off to a receipt", async () => {
    const t = setup([{ status: "confirmed", delivered: "100", decimals: 6 }]);
    const original = fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (args[0] === "/api/sol-swap-broadcast") expect(readSolSwapAttempt(t.storage, wallet)).toMatchObject({ signature: t.sig(), lastValidBlockHeight: 9 });
      return original(...args);
    });
    await t.run();
    expect(readSolSwapAttempt(t.storage, wallet)).toBeNull();
    expect(JSON.parse(t.storage.getItem(solSwapReceiptKey(wallet, poolId))!)).toMatchObject({ signature: t.sig(), delivered: "100" });
  });
  it.each(["throw", "silent-drop", "readback"])("does not broadcast on %s storage failure", async mode => {
    const t = setup([{ status: "confirmed", delivered: "100", decimals: 6 }]);
    const write = t.storage.setItem;
    t.storage.setItem = (key, value) => {
      if (mode === "throw") throw new Error("quota");
      if (mode === "silent-drop") return;
      write(key, value);
      t.storage.getItem = () => { throw new Error("read failed"); };
    };
    await expect(t.run()).rejects.toThrow("Unable to verify saved SOL swap history");
    expect(t.calls).not.toContain("/api/sol-swap-broadcast");
  });
  it("explicit unsent clears only its pending record and permits a fresh attempt", async () => {
    const t = setup([]), original = fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => args[0] === "/api/sol-swap-broadcast"
      ? Response.json({ sent: false, error: "preflight rejected" }, { status: 422 }) : original(...args));
    await expect(t.run()).rejects.toThrow("preflight rejected");
    expect(readSolSwapAttempt(t.storage, wallet)).toBeNull();
  });
  it("retains a timeout across a new caller and recovers using only status reads", async () => {
    vi.useFakeTimers();
    const t = setup([]);
    await expect(t.run({ sleep: async ms => { await vi.advanceTimersByTimeAsync(ms); } })).rejects.toThrow("still unconfirmed");
    const attempt = readSolSwapAttempt(t.storage, wallet)!;
    expect(attempt.signature).toBe(t.sig());
    await expect(t.run()).rejects.toThrow("Check the original SOL swap");
    expect(t.signTransaction).toHaveBeenCalledOnce();
    vi.stubGlobal("fetch", vi.fn(async url => {
      expect(url).toBe("/api/sol-swap-status");
      return Response.json({ status: "confirmed", delivered: "100", decimals: 6 });
    }));
    const receipt = await reconcileSolSwapStep(attempt, { storage: t.storage, current: () => true });
    expect(receipt.signature).toBe(attempt.signature);
    expect(readSolSwapAttempt(t.storage, wallet)).toBeNull();
  });
  it("refuses a stale status result after another attempt replaces its record", async () => {
    const t = setup([{ status: "confirmed", delivered: "100", decimals: 6 }]), original = fetch;
    let replacement = "";
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (args[0] === "/api/sol-swap-status") {
        replacement = JSON.stringify({ ...readSolSwapAttempt(t.storage, wallet)!, signature: bs58.encode(new Uint8Array(64).fill(12)) });
        t.storage.setItem(solSwapAttemptKey(wallet), replacement);
      }
      return original(...args);
    });
    await expect(t.run()).rejects.toThrow("Unable to verify saved SOL swap history");
    expect(t.storage.getItem(solSwapAttemptKey(wallet))).toBe(replacement);
    expect(t.storage.getItem(solSwapReceiptKey(wallet, poolId))).toBeNull();
  });
});
