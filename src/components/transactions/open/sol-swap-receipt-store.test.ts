// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/engine-host", () => ({}));
import { clearSolSwapReceipt, clearWalletSolSwapReceipts, isSolSwapReceiptExpired, loadSolSwapReceipt,
  saveSolSwapReceipt, SOL_SWAP_RECEIPT_TTL_MS, solSwapReceiptKey, type PendingSolSwapReceipt } from "./sol-swap-receipt-store";

const now = 1_800_000_000_000;
const receipt = (over: Partial<PendingSolSwapReceipt> = {}): PendingSolSwapReceipt => ({
  wallet: "WalletA", poolId: "PoolA", signature: "sig1", outputMint: "SpcxMint", outputSymbol: "SPCX",
  delivered: "695", decimals: 6, landedAt: now, ...over,
});
beforeEach(() => window.localStorage.clear());

describe("sol-swap receipt store", () => {
  it("round-trips a receipt for the same wallet + pool", () => {
    saveSolSwapReceipt(window.localStorage, receipt({ openSignature: "open1" }));
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolA", now + 1_000)).toEqual(receipt({ openSignature: "open1" }));
  });
  it("is never returned for another wallet or another pool", () => {
    saveSolSwapReceipt(window.localStorage, receipt());
    expect(loadSolSwapReceipt(window.localStorage, "WalletB", "PoolA", now)).toBeNull();
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolB", now)).toBeNull();
    // A record copied under another wallet's key is rejected (wallet inside must match the key).
    window.localStorage.setItem(solSwapReceiptKey("WalletB", "PoolA"), JSON.stringify(receipt()));
    expect(loadSolSwapReceipt(window.localStorage, "WalletB", "PoolA", now)).toBeNull();
    expect(window.localStorage.getItem(solSwapReceiptKey("WalletB", "PoolA"))).toBeNull();
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolA", now)).not.toBeNull();
  });
  it("expires after the 30-minute fee credit and removes the record", () => {
    saveSolSwapReceipt(window.localStorage, receipt());
    expect(isSolSwapReceiptExpired(receipt(), now + SOL_SWAP_RECEIPT_TTL_MS - 1)).toBe(false);
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolA", now + SOL_SWAP_RECEIPT_TTL_MS - 1)).not.toBeNull();
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolA", now + SOL_SWAP_RECEIPT_TTL_MS)).toBeNull();
    expect(window.localStorage.getItem(solSwapReceiptKey("WalletA", "PoolA"))).toBeNull();
  });
  it("drops malformed records", () => {
    window.localStorage.setItem(solSwapReceiptKey("WalletA", "PoolA"), "{broken");
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolA", now)).toBeNull();
    window.localStorage.setItem(solSwapReceiptKey("WalletA", "PoolA"), JSON.stringify(receipt({ delivered: "0" })));
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolA", now)).toBeNull();
    expect(window.localStorage.getItem(solSwapReceiptKey("WalletA", "PoolA"))).toBeNull();
  });
  it("clears one pool, or every pool of one wallet only", () => {
    saveSolSwapReceipt(window.localStorage, receipt());
    saveSolSwapReceipt(window.localStorage, receipt({ poolId: "PoolB" }));
    saveSolSwapReceipt(window.localStorage, receipt({ wallet: "WalletB" }));
    clearSolSwapReceipt(window.localStorage, "WalletA", "PoolB");
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolB", now)).toBeNull();
    clearWalletSolSwapReceipts(window.localStorage, "WalletA");
    expect(loadSolSwapReceipt(window.localStorage, "WalletA", "PoolA", now)).toBeNull();
    expect(loadSolSwapReceipt(window.localStorage, "WalletB", "PoolA", now)).not.toBeNull();
  });
  it("matches the server-side fee credit window", async () => {
    const server = await import("@/server/transactions/sol-swap-step");
    expect(SOL_SWAP_RECEIPT_TTL_MS).toBe(server.SOL_SWAP_FEE_CREDIT_MS);
  });
});
