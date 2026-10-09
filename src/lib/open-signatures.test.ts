import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { missingRequiredSignatures, preserveExtraSignatures } from "./open-signatures";

describe("open-position extra signatures", () => {
  it("restores a dropped NFT-mint partial signature after the wallet signs", () => {
    const payer = Keypair.generate();
    const nft = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [new TransactionInstruction({
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: nft.publicKey, isSigner: true, isWritable: false },
        ],
        programId: SystemProgram.programId,
        data: Buffer.alloc(0),
      })],
    }).compileToV0Message();
    const prepared = new VersionedTransaction(message);
    prepared.sign([nft]);
    expect(prepared.message.header.numRequiredSignatures).toBe(2);
    expect(prepared.signatures[0]?.every((byte) => byte === 0)).toBe(true);
    expect(prepared.signatures[1]?.some((byte) => byte !== 0)).toBe(true);
    const walletOnly = VersionedTransaction.deserialize(prepared.serialize());
    walletOnly.sign([payer]);
    walletOnly.signatures[1] = new Uint8Array(64);
    const restored = preserveExtraSignatures(prepared, walletOnly);
    expect(Buffer.from(restored.signatures[0]!)).toEqual(Buffer.from(walletOnly.signatures[0]!));
    expect(Buffer.from(restored.signatures[1]!)).toEqual(Buffer.from(prepared.signatures[1]!));
  });

  it("reports missing required signatures", () => {
    const payer = Keypair.generate();
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1,
      })],
    }).compileToV0Message());
    expect(missingRequiredSignatures(tx)).toEqual([0]);
    tx.sign([payer]);
    expect(missingRequiredSignatures(tx)).toEqual([]);
  });
});
