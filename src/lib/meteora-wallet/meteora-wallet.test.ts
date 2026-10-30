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
});
