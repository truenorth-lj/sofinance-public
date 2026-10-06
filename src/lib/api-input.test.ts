import { describe, expect, it } from "vitest";
import { parseSelectedQuoteRequest, parseWallet } from "./api-input";

const wallet = "11111111111111111111111111111111"; // Fake but valid base58 test wallet

function request(body: unknown) {
  return new Request("http://localhost/api/selected-quote", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("API input boundary", () => {
  it("normalizes the wallet and validates the selected position and asset", async () => {
    expect(parseWallet(wallet)).toBe(wallet);
    const positionMint = "So11111111111111111111111111111111111111112";
    const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    await expect(parseSelectedQuoteRequest(request({ wallet, positionMint, inputMint,
      inputKind: "token", amount: "11.000001", floorBps: 9_500 })))
      .resolves.toEqual({ wallet, selection: { positionMint, inputMint, inputKind: "token" }, amount: "11.000001", floorBps: 9_500 });
  });

  it("rejects invalid addresses, mints, and an unsupported floor before route lookup", async () => {
    const valid = { wallet, positionMint: "So11111111111111111111111111111111111111112",
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", inputKind: "token", amount: "11" };
    await expect(parseSelectedQuoteRequest(request({ ...valid, wallet: "invalid" }))).rejects.toThrow(/wallet/);
    await expect(parseSelectedQuoteRequest(request({ ...valid, inputMint: "invalid" }))).rejects.toThrow(/mint/);
    await expect(parseSelectedQuoteRequest(request({ ...valid, floorBps: 9_499 }))).rejects.toThrow(/threshold/);
    await expect(parseSelectedQuoteRequest(request([]))).rejects.toThrow(/input/);
  });
});
