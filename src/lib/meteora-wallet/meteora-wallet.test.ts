import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { meteoraFailedOnChainMessage, meteoraPlainError, solscanTxUrl } from "./errors";
import { parseMeteoraPending } from "./pending";

const A = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
const base = { wallet: A, poolId: A, position: A, inputMint: A, lowerBinId: 1, upperBinId: 5, amount: "100", stage: "setup_confirmed", setupSignature: bs58.encode(new Uint8Array(64).fill(5)) };

describe("meteora wallet helpers", () => {
  it("parses only well-formed pending records (public data only)", () => {
    expect(parseMeteoraPending(JSON.stringify(base))).toEqual(base);
    expect(parseMeteoraPending(null)).toBeNull();
    expect(parseMeteoraPending("{bad")).toBeNull();
    expect(parseMeteoraPending(JSON.stringify({ ...base, stage: "weird" }))).toBeNull();
    expect(parseMeteoraPending(JSON.stringify({ ...base, amount: "-1" }))).toBeNull();
    expect(parseMeteoraPending(JSON.stringify({ ...base, setupSignature: "0OIl" }))).toBeNull();
  });

  it("uses plain words", () => {
    const rejected = Object.assign(new Error("User rejected the request."), { name: "WalletSignTransactionError" });
    expect(meteoraPlainError(rejected, "sign")).toBe("You cancelled the request in your wallet. Nothing was sent.");
    expect(meteoraPlainError("Not enough SOL: add about 0.0450 SOL.")).toBe("Not enough SOL: add about 0.0450 SOL.");
    expect(meteoraPlainError("Simulation failed: {\"InstructionError\":[2,{\"Custom\":1}]}")).toMatch(/would fail right now/);
    expect(meteoraPlainError(new TypeError("Failed to fetch"))).toMatch(/Could not reach SoFinance/);
    expect(meteoraFailedOnChainMessage("deposit")).toMatch(/close the empty position/);
    expect(solscanTxUrl("abc")).toBe("https://solscan.io/tx/abc");
  });

  it("only an explicit wallet rejection says cancelled; other wallet or relay failures say Couldn't send, never a URL", () => {
    // The adapter's class name wraps every wallet failure: not a cancel by itself (it was, before 2026-11-03).
    const wrapped = Object.assign(new Error("Unexpected error"), { name: "WalletSignTransactionError" });
    expect(meteoraPlainError(wrapped, "sign")).toBe("Couldn't send the transaction: your wallet said “Unexpected error”. Nothing was sent.");
    expect(meteoraPlainError(Object.assign(new Error("x"), { code: 4001 }), "sign")).toBe("You cancelled the request in your wallet. Nothing was sent.");
    const rpc = "failed: 503 from https://mainnet.example-rpc.com/?api-key=SECRET123";
    for (const context of ["sign", "send", "prepare"] as const) {
      const text = meteoraPlainError(new Error(rpc), context);
      expect(text).not.toMatch(/https?:|example-rpc|SECRET123|api-key/);
      if (context !== "prepare") expect(text).toMatch(/^Couldn't send the transaction: /);
    }
    expect(meteoraPlainError("rpc_unavailable", "send")).toBe("Couldn't send the transaction: it could not reach the Solana network. Nothing was sent.");
    expect(solscanTxUrl("abc")).toBe("https://solscan.io/tx/abc");
  });
});
