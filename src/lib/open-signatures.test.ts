import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  addMintSignature, assertWalletReturnedTransaction, missingRequiredSignatures, preserveExtraSignatures,
} from "./open-signatures";
import { appendWalletExtraInstruction } from "./test-support/send-fixtures";

function twoSignerTx(payer: Keypair, nft: Keypair) {
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
  return new VersionedTransaction(message);
}

describe("open-position extra signatures", () => {
  it("restores a dropped NFT-mint partial signature after the wallet signs", () => {
    const payer = Keypair.generate();
    const nft = Keypair.generate();
    const prepared = twoSignerTx(payer, nft);
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

  it("wallet-first then mint-sign produces a valid fully-signed transaction", () => {
    const payer = Keypair.generate();
    const nft = Keypair.generate();
    const prepared = twoSignerTx(payer, nft);
    expect(prepared.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    const walletSigned = VersionedTransaction.deserialize(prepared.serialize());
    walletSigned.sign([payer]);
    const walletSignature = Uint8Array.from(walletSigned.signatures[0]!);
    assertWalletReturnedTransaction(prepared, walletSigned, payer.publicKey.toBase58());
    const signed = addMintSignature(walletSigned, nft);
    expect(missingRequiredSignatures(signed)).toEqual([]);
    expect(Buffer.from(signed.signatures[0]!)).toEqual(Buffer.from(walletSignature));
    expect(signed.signatures[1]?.some((byte) => byte !== 0)).toBe(true);
    nft.secretKey.fill(0);
  });

  it("wallet-first then mint-sign still works when the wallet appends a Lighthouse instruction", () => {
    const payer = Keypair.generate();
    const nft = Keypair.generate();
    const prepared = twoSignerTx(payer, nft);
    const extra = appendWalletExtraInstruction(prepared);
    extra.sign([payer]);
    assertWalletReturnedTransaction(prepared, extra, payer.publicKey.toBase58());
    const signed = addMintSignature(extra, nft);
    expect(missingRequiredSignatures(signed)).toEqual([]);
    nft.secretKey.fill(0);
  });

  it("rejects a wallet that changes the fee payer or a core instruction", () => {
    const payer = Keypair.generate();
    const nft = Keypair.generate();
    const prepared = twoSignerTx(payer, nft);
    const mutated = VersionedTransaction.deserialize(prepared.serialize());
    mutated.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    mutated.sign([payer]);
    expect(() => assertWalletReturnedTransaction(prepared, mutated, payer.publicKey.toBase58()))
      .toThrow("Wallet changed the transaction blockhash");
  });
});
