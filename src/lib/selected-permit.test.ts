import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { issueSelectedPermit, verifySelectedPermit } from "./selected-permit";

describe("selected atomic permit", () => {
  it("rejects a changed source mint or position with the same transaction message", () => {
    const key = () => Keypair.generate().publicKey.toBase58();
    const input = {
      message: "base64-message", wallet: key(),
      selection: { positionMint: key(), inputMint: key(), inputKind: "token" as const },
      requested: "100", floorBps: 9900, expiresAt: 1000, lastValidBlockHeight: 100,
      startingLiquidity: "10", expectedLiquidity: "5", rangeSide: "inside",
      startingBalances: { input: "100", a: "0", b: "0" },
    };
    const permit = issueSelectedPermit("secret", input);
    expect(verifySelectedPermit("secret", input, permit)).toBe(true);
    expect(verifySelectedPermit("secret", { ...input, selection: { ...input.selection, inputMint: key() } }, permit)).toBe(false);
    expect(verifySelectedPermit("secret", { ...input, selection: { ...input.selection, positionMint: key() } }, permit)).toBe(false);
  });
});
