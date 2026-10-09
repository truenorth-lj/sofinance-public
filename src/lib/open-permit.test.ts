import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { issueOpenPositionPermit, verifyOpenPositionPermit } from "./open-permit";

describe("open-position permit", () => {
  it("binds wallet, message, pool, ticks, nft mint, and amounts", () => {
    const key = () => Keypair.generate().publicKey.toBase58();
    const input = {
      wallet: key(),
      message: "base64-message",
      summary: {
        operation: "open-position",
        poolId: key(),
        nftMint: key(),
        tickLower: -30,
        tickUpper: 30,
        quote: { requested: "100", liquidity: "5", inputMint: key() },
      },
    };
    const permit = issueOpenPositionPermit("secret", input);
    expect(verifyOpenPositionPermit("secret", input, permit)).toBe(true);
    expect(verifyOpenPositionPermit("secret", { ...input, wallet: key() }, permit)).toBe(false);
    expect(verifyOpenPositionPermit("secret", { ...input, message: "other" }, permit)).toBe(false);
    expect(verifyOpenPositionPermit("secret", {
      ...input,
      summary: { ...input.summary, nftMint: key() },
    }, permit)).toBe(false);
    expect(verifyOpenPositionPermit("secret", {
      ...input,
      summary: { ...input.summary, tickLower: -10 },
    }, permit)).toBe(false);
    expect(verifyOpenPositionPermit("other", input, permit)).toBe(false);
    expect(verifyOpenPositionPermit("secret", input, "not-a-permit")).toBe(false);
  });

  it("survives JSON key reordering", () => {
    const input = {
      wallet: "wallet",
      message: "message",
      summary: { operation: "open-position", liquidity: "10", nftMint: "mint", expiresAt: 500 },
    };
    const permit = issueOpenPositionPermit("test-secret", input);
    const reordered = {
      summary: { expiresAt: 500, nftMint: "mint", liquidity: "10", operation: "open-position" },
      message: input.message,
      wallet: input.wallet,
    };
    expect(verifyOpenPositionPermit("test-secret", reordered, permit)).toBe(true);
  });
});
