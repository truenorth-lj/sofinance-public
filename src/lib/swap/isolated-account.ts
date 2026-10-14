import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createInitializeAccountInstruction } from "@solana/spl-token";
export type IsolatedTokenAccount = {
    seed: string;
    address: string;
    mint: string;
    program: string;
    space: number;
    rentLamports: number;
};
export function createIsolatedTokenAccountInstructions(wallet: PublicKey, account: IsolatedTokenAccount) {
    const address = new PublicKey(account.address), program = new PublicKey(account.program);
    // NON-idempotent creation rejects any pre-funded source. InitializeAccount
    // references the payer/owner by index rather than repeating its 32 bytes.
    // Both initializations share the rent sysvar in Raydium's common ALT.
    return [SystemProgram.createAccountWithSeed({ fromPubkey: wallet, basePubkey: wallet, seed: account.seed,
            newAccountPubkey: address, lamports: account.rentLamports, space: account.space, programId: program }),
        createInitializeAccountInstruction(address, new PublicKey(account.mint), wallet, program)];
}
