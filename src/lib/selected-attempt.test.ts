import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { parseSelectedAttempt } from "./selected-attempt";

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
