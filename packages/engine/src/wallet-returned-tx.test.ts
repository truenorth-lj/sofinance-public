import { describe, expect, it } from "vitest";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  LIGHTHOUSE_PROGRAM_ID, assertWalletReturnedTransaction, landedInstructionsMatchPrepared, landedReceiptIsPrepared,
  landedTransactionMatchesPrepared, walletReturnedTransactionMatches, walletReturnedTxDiagnostic,
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

function loadedFromTable(tx: VersionedTransaction, table: AddressLookupTableAccount) {
  const lookup = tx.message.addressTableLookups[0]!;
  return {
    writable: [...lookup.writableIndexes].map((index) => table.state.addresses[index]!),
    readonly: [...lookup.readonlyIndexes].map((index) => table.state.addresses[index]!),
  };
}

it("matches a Phantom-modified landed tx and resolves ALT accounts from loadedAddresses", () => {
  const payer = Keypair.generate();
  const dest = Keypair.generate().publicKey;
  const memoProgram = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 5 });
  const memo = new TransactionInstruction({
    programId: memoProgram,
    keys: [{ pubkey: dest, isSigner: false, isWritable: true }],
    data: Buffer.from("core"),
  });
  const prepared = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), transfer, memo],
  }).compileToV0Message());
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [dest, memoProgram],
    },
  });
  const landed = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      transfer,
      new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([2]) }),
      memo,
    ],
  }).compileToV0Message([table]));
  const loaded = loadedFromTable(landed, table);
  expect(landed.message.addressTableLookups.length).toBeGreaterThan(0);
  expect(loaded.writable.some((key) => key.equals(dest))).toBe(true);
  expect(walletReturnedTransactionMatches(prepared, landed, payer.publicKey.toBase58(), loaded)).toBe(true);
  expect(landedTransactionMatchesPrepared(prepared, {
    transaction: { message: landed.message },
    meta: { err: null, loadedAddresses: loaded },
  }, payer.publicKey.toBase58())).toBe(true);
  const spoofed = {
    writable: loaded.writable.map((key) => key.equals(dest) ? Keypair.generate().publicKey : key),
    readonly: loaded.readonly,
  };
  expect(walletReturnedTransactionMatches(prepared, landed, payer.publicKey.toBase58(), spoofed)).toBe(false);
  expect(landedTransactionMatchesPrepared(prepared, {
    transaction: { message: landed.message },
    meta: { err: "InstructionError" },
  }, payer.publicKey.toBase58())).toBe(false);
  expect(landedTransactionMatchesPrepared(prepared, null, payer.publicKey.toBase58())).toBe(false);
});

// Shared allow-list (client, server checks, /api/tx-send): ComputeBudget, Lighthouse, Memo by static key.
function phantomMainnetOpen(payer: Keypair, mint: Keypair, extra: TransactionInstruction[] = []) {
  const dlmm = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const blockhash = Keypair.generate().publicKey.toBase58();
  const core = [new TransactionInstruction({ programId: dlmm, data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: mint.publicKey, isSigner: true, isWritable: true },
  ] })];
  const compile = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
  const prepared = compile(core);
  // Lighthouse bytes as Phantom returned them on mainnet: AssertAccountData + AssertSysvarClock.
  const signed = compile([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: false }],
      data: Buffer.from("02001007e4dd13630700000005", "hex") }),
    new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from("0f0000fbeda21b0000000005", "hex") }),
    ...core, ...extra,
  ]);
  return { prepared, signed };
}

it("Lighthouse is the mainnet program Phantom inserts (L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95)", () => {
  expect(LIGHTHOUSE_PROGRAM_ID.toBase58()).toBe("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
});

it("accepts Phantom's mainnet Lighthouse + ComputeBudget return of an open with a mint cosigner", () => {
  const payer = Keypair.generate(), mint = Keypair.generate();
  const { prepared, signed } = phantomMainnetOpen(payer, mint);
  expect(walletReturnedTxDiagnostic(prepared, signed)).toBeNull();
  expect(() => assertWalletReturnedTransaction(prepared, signed, payer.publicKey.toBase58())).not.toThrow();
});

it("refuses an inserted SystemProgram.transfer or an unlisted program next to Phantom's Lighthouse", () => {
  const payer = Keypair.generate(), mint = Keypair.generate();
  const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 });
  const lookalike = new TransactionInstruction({ programId: new PublicKey("L2TExMFKdjpN9kozasaurPPf4nCVfRTb7cTZo5GsqqY"), keys: [], data: Buffer.from([1]) });
  for (const extra of [transfer, lookalike]) {
    const { prepared, signed } = phantomMainnetOpen(payer, mint, [extra]);
    expect(walletReturnedTxDiagnostic(prepared, signed)).toMatchObject({ kind: "extra", unmatchedProgramId: extra.programId.toBase58() });
    expect(() => assertWalletReturnedTransaction(prepared, signed, payer.publicKey.toBase58())).toThrow(/Wallet added an instruction from a program that is not allowed/);
  }
});

describe("post-landing match: our instructions present and in order, extras tolerated", () => {
  const receipt = (tx: VersionedTransaction, err: unknown = null) => ({ transaction: { message: tx.message }, meta: { err } });
  it("matches a landed tx with wallet-added instructions from any program, while pre-send checks still refuse it", () => {
    const payer = Keypair.generate(), mint = Keypair.generate();
    const unlisted = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([9]) });
    const { prepared, signed } = phantomMainnetOpen(payer, mint, [unlisted]);
    const wallet = payer.publicKey.toBase58();
    expect(walletReturnedTransactionMatches(prepared, signed, wallet)).toBe(false);
    expect(() => assertWalletReturnedTransaction(prepared, signed, wallet)).toThrow();
    expect(landedInstructionsMatchPrepared(prepared, signed, wallet)).toBe(true);
    expect(landedTransactionMatchesPrepared(prepared, receipt(signed), wallet)).toBe(true);
  });
  it("matches Phantom's mainnet ComputeBudget + Lighthouse rewrite", () => {
    const payer = Keypair.generate(), mint = Keypair.generate();
    const { prepared, signed } = phantomMainnetOpen(payer, mint);
    expect(landedTransactionMatchesPrepared(prepared, receipt(signed), payer.publicKey.toBase58())).toBe(true);
  });
  it("refuses a landed tx that is missing, reorders or changes one of our instructions", () => {
    const payer = Keypair.generate();
    const wallet = payer.publicKey.toBase58();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const a = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const b = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1, 2]) });
    const compile = (instructions: TransactionInstruction[], hash = blockhash, payerKey = payer.publicKey) => new VersionedTransaction(
      new TransactionMessage({ payerKey, recentBlockhash: hash, instructions }).compileToV0Message());
    const prepared = compile([a, b]);
    const extra = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([3]) });
    expect(landedInstructionsMatchPrepared(prepared, compile([extra, a, extra, b, extra]), wallet)).toBe(true);
    expect(landedInstructionsMatchPrepared(prepared, compile([a]), wallet)).toBe(false);
    expect(landedInstructionsMatchPrepared(prepared, compile([b, a]), wallet)).toBe(false);
    const changed = new TransactionInstruction({ programId: b.programId, keys: [], data: Buffer.from([1, 3]) });
    expect(landedInstructionsMatchPrepared(prepared, compile([a, changed]), wallet)).toBe(false);
    expect(landedInstructionsMatchPrepared(prepared, compile([a, b], Keypair.generate().publicKey.toBase58()), wallet)).toBe(false);
  });
  it("finds a landed-but-failed tx for lookup, while the success matcher still refuses it", () => {
    const payer = Keypair.generate(), mint = Keypair.generate();
    const { prepared, signed } = phantomMainnetOpen(payer, mint);
    const wallet = payer.publicKey.toBase58();
    expect(landedReceiptIsPrepared(prepared, receipt(signed, { InstructionError: [0, "Custom"] }), wallet)).toBe(true);
    expect(landedTransactionMatchesPrepared(prepared, receipt(signed, { InstructionError: [0, "Custom"] }), wallet)).toBe(false);
    expect(landedReceiptIsPrepared(prepared, null, wallet)).toBe(false);
  });
});
