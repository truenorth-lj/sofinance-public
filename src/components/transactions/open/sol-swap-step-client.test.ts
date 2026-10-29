import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import type { VersionedTransaction } from "@solana/web3.js";
import { buildTransaction, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { rawToDecimalString, runSolSwapStep, SolSwapStepError } from "./sol-swap-step-client";

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

function setup(statuses: Array<Record<string, unknown>>, prepareOver: Record<string, unknown> = {}) {
  const tx = buildTransaction({ payer, signWith: [] });
  const summary = { operation: "sol-swap-step", wallet, poolId: "pool", requested: "1000000", outputMint, outputSymbol: "SPCX",
    blockhash: tx.message.recentBlockhash, lastValidBlockHeight: 9, expiresAt: Date.now() + 60_000, ...prepareOver };
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
  const run = () => runSolSwapStep({ wallet, poolId: "pool", amount: "0.001", requested: "1000000", store: new Map() as never,
    timeoutMs: 5_000, signTransaction, setStage: s => stages.push(s), current: () => true, sleep: async () => {} });
  return { run, calls, stages, signTransaction, sig: () => sig };
}
afterEach(() => vi.unstubAllGlobals());

describe("runSolSwapStep (step 1/2)", () => {
  it("returns the amount the confirmed swap delivered, not the quote", async () => {
    const t = setup([{ status: "pending" }, { status: "confirmed", delivered: "24650000", decimals: 9 }]);
    const receipt = await t.run();
    expect(receipt).toEqual({ wallet, poolId: "pool", signature: t.sig(), outputMint, outputSymbol: "SPCX", delivered: "24650000", decimals: 9 });
    expect(t.stages).toEqual(["swap-preparing", "swap-wallet", "swap-broadcasting", "swap-pending"]);
    expect(t.calls.filter(u => u === "/api/sol-swap-status")).toHaveLength(2);
  });
  it("reports an on-chain failure with the signature and opens nothing", async () => {
    const t = setup([{ status: "failed" }]);
    const error = await t.run().catch(e => e);
    expect(error).toBeInstanceOf(SolSwapStepError);
    expect(error.signature).toBe(t.sig());
  });
  it("refuses a prepared swap for another amount before asking the wallet", async () => {
    const t = setup([], { requested: "2000000" });
    await expect(t.run()).rejects.toThrow("Prepared SOL swap expired or incomplete");
    expect(t.signTransaction).not.toHaveBeenCalled();
  });
});
