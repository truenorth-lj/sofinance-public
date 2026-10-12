import BN from "bn.js";
import { CLMM_PROGRAM_ID, ClmmInstrument, getPdaExBitmapAccount, getPdaPersonalPositionAddress } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { buildSelectedAddInstruction } from "./selected-add-instruction";

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const wallet = key(1), pool = key(2), nft = key(3), mintA = key(4), mintB = key(5);
const quote = { liquidity: "123456789012345678901234", amountMaxA: "123456789012345", amountMaxB: "234567890123456" };

describe.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])("selected add NFT program %s", (nftProgram) => {
  it.each([
    { tickLower: -61, tickUpper: 60, tickSpacing: 1, overflow: false },
    { tickLower: -120, tickUpper: 136, tickSpacing: 8, overflow: false },
    { tickLower: -40_000, tickUpper: -39_940, tickSpacing: 1, overflow: true },
    { tickLower: 40_000, tickUpper: 40_060, tickSpacing: 1, overflow: true },
  ])("matches SDK bytes and ordered accounts for $tickLower..$tickUpper", ({ tickLower, tickUpper, tickSpacing, overflow }) => {
    const state = {
      programId: CLMM_PROGRAM_ID.toBase58(), poolId: pool.toBase58(),
      nftAta: getAssociatedTokenAddressSync(nft, wallet, false, nftProgram).toBase58(),
      positionAccount: getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey.toBase58(),
      mintA: mintA.toBase58(), mintB: mintB.toBase58(),
      ataA: getAssociatedTokenAddressSync(mintA, wallet).toBase58(),
      ataB: getAssociatedTokenAddressSync(mintB, wallet, false, TOKEN_2022_PROGRAM_ID).toBase58(),
      vaultA: key(6).toBase58(), vaultB: key(7).toBase58(), tickLower, tickUpper, tickSpacing,
    };
    type SdkInput = Parameters<typeof ClmmInstrument.increasePositionFromLiquidityInstructions>[0];
    const reference = ClmmInstrument.increasePositionFromLiquidityInstructions({
      poolInfo: { programId: state.programId, id: state.poolId, config: { tickSpacing },
        mintA: { address: state.mintA }, mintB: { address: state.mintB } } as SdkInput["poolInfo"],
      poolKeys: { vault: { A: state.vaultA, B: state.vaultB } } as SdkInput["poolKeys"],
      ownerPosition: { nftMint: nft, tickLower, tickUpper } as SdkInput["ownerPosition"],
      ownerInfo: { wallet, tokenAccountA: new PublicKey(state.ataA), tokenAccountB: new PublicKey(state.ataB) },
      liquidity: new BN(quote.liquidity), amountMaxA: new BN(quote.amountMaxA), amountMaxB: new BN(quote.amountMaxB),
      nft2022: nftProgram.equals(TOKEN_2022_PROGRAM_ID),
    });
    const actual = buildSelectedAddInstruction(state, quote, wallet);
    expect(reference.instructions).toHaveLength(1);
    expect(actual.programId).toEqual(reference.instructions[0]!.programId);
    expect(actual.data).toEqual(reference.instructions[0]!.data);
    expect(actual.keys).toEqual(reference.instructions[0]!.keys);
    expect(actual.keys[1]!.pubkey.toBase58()).toBe(state.nftAta);
    expect(actual.keys).toHaveLength(overflow ? 16 : 15);
    if (overflow) expect(actual.keys.at(-1)!.pubkey).toEqual(getPdaExBitmapAccount(CLMM_PROGRAM_ID, pool).publicKey);
    expect(reference.signers).toEqual([]);
  });
});
