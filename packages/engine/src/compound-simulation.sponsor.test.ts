import { Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { simulateAndVerifyCompound } from "./compound-simulation";

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const wallet = key(1), sponsor = key(2);
const tx = (payer: PublicKey, signers: PublicKey[]) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111",
  instructions: [new TransactionInstruction({ programId: key(9), keys: signers.map(pubkey => ({ pubkey, isSigner: true, isWritable: false })), data: Buffer.alloc(1) })] }).compileToV0Message());
const input = (transaction: VersionedTransaction, feePayer?: string) => ({ connection: {} as never, transaction, state: { wallet: wallet.toBase58() } as never,
  compoundAccounts: [] as never, expectedLiquidity: 0n, maxSolDebitLamports: 0n, sigVerify: false, ...(feePayer ? { feePayer } : {}) });

describe("compound signer layout", () => {
  it("owner mode still accepts only the wallet as sole signer", async () => {
    await expect(simulateAndVerifyCompound(input(tx(sponsor, [wallet])))).rejects.toThrow("Compound only allows selected wallet signature");
  });
  it("sponsored mode requires exactly fee payer then wallet", async () => {
    await expect(simulateAndVerifyCompound(input(tx(wallet, []), sponsor.toBase58()))).rejects.toThrow("Sponsored compound only allows fee payer + selected wallet signatures");
    await expect(simulateAndVerifyCompound(input(tx(sponsor, [wallet, key(3)]), sponsor.toBase58()))).rejects.toThrow("Sponsored compound only allows");
    // Correct layout passes the signer gate (and fails later only because this stub has no state/RPC).
    await expect(simulateAndVerifyCompound(input(tx(sponsor, [wallet]), sponsor.toBase58()))).rejects.not.toThrow("only allows");
  });
});
