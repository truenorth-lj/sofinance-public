import { expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { LIGHTHOUSE_PROGRAM_ID, assertWalletReturnedTransaction, walletReturnedTransactionMatches } from "./wallet-returned-tx";

function transferTx(payer: Keypair, dest = Keypair.generate().publicKey) {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 1 })],
  }).compileToV0Message());
}

function withExtra(tx: VersionedTransaction, extra: TransactionInstruction) {
  const message = TransactionMessage.decompile(tx.message);
  return new VersionedTransaction(new TransactionMessage({
    payerKey: message.payerKey,
    recentBlockhash: message.recentBlockhash,
    instructions: [...message.instructions, extra],
  }).compileToV0Message());
}

it("accepts a wallet-appended Lighthouse instruction", () => {
  const payer = Keypair.generate();
  const prepared = transferTx(payer);
  const signed = withExtra(prepared, new TransactionInstruction({
    programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([1]),
  }));
  signed.sign([payer]);
  assertWalletReturnedTransaction(prepared, signed, payer.publicKey.toBase58());
});

it("rejects a changed fee payer or removed core instruction", () => {
  const payer = Keypair.generate();
  const other = Keypair.generate();
  const prepared = transferTx(payer);
  const swapped = new VersionedTransaction(new TransactionMessage({
    payerKey: other.publicKey,
    recentBlockhash: prepared.message.recentBlockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message());
  swapped.sign([other]);
  expect(() => assertWalletReturnedTransaction(prepared, swapped, payer.publicKey.toBase58()))
    .toThrow("Wallet changed the transaction fee payer");
  const emptied = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: prepared.message.recentBlockhash,
    instructions: [new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([9]) })],
  }).compileToV0Message());
  emptied.sign([payer]);
  expect(() => assertWalletReturnedTransaction(prepared, emptied, payer.publicKey.toBase58()))
    .toThrow("Wallet removed or changed a required instruction");
  expect(walletReturnedTransactionMatches(prepared, emptied, payer.publicKey.toBase58())).toBe(false);
  const destChanged = transferTx(payer);
  destChanged.message.recentBlockhash = prepared.message.recentBlockhash;
  destChanged.sign([payer]);
  expect(() => assertWalletReturnedTransaction(prepared, destChanged, payer.publicKey.toBase58()))
    .toThrow("Wallet removed or changed a required instruction");
});
