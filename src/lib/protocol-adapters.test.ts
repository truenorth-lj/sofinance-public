import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getAppProtocolBuilders } from "./protocol-adapters";
import { buildSelectedAddInstruction } from "./selected-add-instruction";

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;

describe("app protocol builders", () => {
  it("Raydium add is the existing builder and prepares the same golden instruction", () => {
    const builders = getAppProtocolBuilders();
    expect(builders).toBe(getAppProtocolBuilders("raydium-clmm"));
    expect(builders.buildAddInstruction).toBe(buildSelectedAddInstruction);
    const wallet = key(1), nft = key(3), mintA = key(4), mintB = key(5);
    const state = {
      programId: CLMM_PROGRAM_ID.toBase58(), poolId: key(2).toBase58(),
      nftAta: getAssociatedTokenAddressSync(nft, wallet).toBase58(),
      positionAccount: getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey.toBase58(),
      mintA: mintA.toBase58(), mintB: mintB.toBase58(),
      ataA: getAssociatedTokenAddressSync(mintA, wallet).toBase58(),
      ataB: getAssociatedTokenAddressSync(mintB, wallet, false, TOKEN_2022_PROGRAM_ID).toBase58(),
      vaultA: key(6).toBase58(), vaultB: key(7).toBase58(), tickLower: -120, tickUpper: 136, tickSpacing: 8,
    };
    const quote = { liquidity: "123456789012345678901234", amountMaxA: "123456789012345", amountMaxB: "234567890123456" };
    const ix = builders.buildAddInstruction(state, quote, wallet);
    expect(ix).toEqual(buildSelectedAddInstruction(state, quote, wallet));
    expect({ program: ix.programId.toBase58(), data: ix.data.toString("hex"),
      keys: ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]) }).toMatchSnapshot();
  });
});
