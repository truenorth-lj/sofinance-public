import { expect, it } from "vitest";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  LIGHTHOUSE_PROGRAM_ID, assertWalletReturnedTransaction, walletReturnedTransactionMatches,
  walletReturnedTxDiagnostic,
} from "./wallet-returned-tx";

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

function swapUnsignedKeys(tx: VersionedTransaction, left: number, right: number) {
  const keys = tx.message.staticAccountKeys;
  const temp = keys[left]!;
  keys[left] = keys[right]!;
  keys[right] = temp;
  const remap = (index: number) => (index === left ? right : index === right ? left : index);
  for (const ix of tx.message.compiledInstructions) {
    ix.programIdIndex = remap(ix.programIdIndex);
    ix.accountKeyIndexes = ix.accountKeyIndexes.map(remap);
  }
}

function phantomRecompile(payer: Keypair, dest: PublicKey, memoProgram: PublicKey, blockhash: string) {
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 5 });
  const memo = new TransactionInstruction({
    programId: memoProgram,
    keys: [{ pubkey: dest, isSigner: false, isWritable: true }],
    data: Buffer.from("core"),
  });
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [dest, memoProgram],
    },
  });
  const prepared = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [limit, transfer, memo],
  }).compileToV0Message([table]));
  const rewritten = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      transfer,
      new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([2]) }),
      memo,
    ],
  }).compileToV0Message());
  const unsigned = rewritten.message.header.numRequiredSignatures;
  if (rewritten.message.staticAccountKeys.length - unsigned >= 2) {
    swapUnsignedKeys(rewritten, rewritten.message.staticAccountKeys.length - 2, rewritten.message.staticAccountKeys.length - 1);
  }
  return { prepared, rewritten };
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

it("accepts reordered keys, replaced ComputeBudget, and an inserted Lighthouse instruction", () => {
  const payer = Keypair.generate();
  const dest = Keypair.generate().publicKey;
  const memoProgram = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const { prepared, rewritten } = phantomRecompile(payer, dest, memoProgram, blockhash);
  rewritten.sign([payer]);
  assertWalletReturnedTransaction(prepared, rewritten, payer.publicKey.toBase58());
  expect(walletReturnedTransactionMatches(prepared, rewritten, payer.publicKey.toBase58())).toBe(true);
  expect(walletReturnedTxDiagnostic(prepared, rewritten)).toBeNull();
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
    .toThrow(/Wallet removed or changed a required instruction \(unmatched #0 program=/);
  expect(walletReturnedTransactionMatches(prepared, emptied, payer.publicKey.toBase58())).toBe(false);
  const destChanged = transferTx(payer);
  destChanged.message.recentBlockhash = prepared.message.recentBlockhash;
  destChanged.sign([payer]);
  expect(() => assertWalletReturnedTransaction(prepared, destChanged, payer.publicKey.toBase58()))
    .toThrow(/Wallet removed or changed a required instruction/);
});
