import "server-only";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";

/** Personal position PDA of each position NFT mint: the first account `readRaydiumPositionAccounts` reads. Bad ids are skipped. */
export function raydiumPortfolioAccountKeys(positionMints: readonly string[]): string[] {
  return positionMints.flatMap((mint) => {
    try { return [getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, new PublicKey(mint)).publicKey.toBase58()]; } catch { return []; }
  });
}
