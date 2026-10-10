import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it, vi } from "vitest";
import compactFixture from "./fixtures/open-size-compact-route.json";
import fixture from "./fixtures/open-size-route.json";
import { assertOpenTransactionSize, compactAtaInstructions, compileCompactOpenTransaction, versionedTransactionSize } from "./open-transaction";

const instructions = fixture.instructions.map(ix => new TransactionInstruction({
  programId: new PublicKey(ix.program), data: Buffer.from(ix.data, "base64"),
  keys: ix.accounts.map(([address, flags]) => ({ pubkey: new PublicKey(address as string), isSigner: Boolean((flags as number) & 1), isWritable: Boolean((flags as number) & 2) })),
}));
const tables = fixture.tables.map(table => new AddressLookupTableAccount({ key: new PublicKey(table.key), state: {
  deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
  addresses: Array.from({ length: table.length }, (_, index) => new PublicKey(
      table.entries.find(entry => entry[0] === index)?.[1] as string ?? PublicKey.default.toBase58())),
} }));
const input = { payerKey: new PublicKey(fixture.payer), recentBlockhash: fixture.blockhash, instructions };

describe("open-position transaction compaction", () => {
  it("reproduces the captured two-swap + open transaction exceeding 1,232 bytes", () => {
    const original = new VersionedTransaction(new TransactionMessage(input).compileToV0Message(tables));
    expect(versionedTransactionSize(original)).toBe(1524);
    expect(() => assertOpenTransactionSize(original)).toThrow(/1524 bytes/);
  });
  it("reduces the original route without falsely accepting a route that still exceeds the limit", async () => {
    // These are the two real Jupiter route sequences from the capture. In
    // production wrapAndUnwrapSol=false removes each route's wrap and close;
    // the caller supplies one wrap before both routes and one close after LP.
    const sharedWrap = [instructions[1]!, instructions[2]!, instructions[3]!];
    const combined = [instructions[0]!, ...sharedWrap,
      ...instructions.slice(4, 7), ...instructions.slice(11, 14),
      ...instructions.slice(15), instructions[14]!];
    const connection = { getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(() => null)) };
    const compacted = await compactAtaInstructions(connection as never, combined);
    const compact = compileCompactOpenTransaction({ ...input, instructions: compacted }, tables);
    expect(versionedTransactionSize(compact.transaction)).toBeLessThan(1524);
    expect(() => assertOpenTransactionSize(compact.transaction)).toThrow(/exceeds/);
    expect(compact.transaction.message.header.numRequiredSignatures).toBe(2);
    const decompiled = TransactionMessage.decompile(compact.transaction.message, { addressLookupTableAccounts: compact.tables });
    expect(decompiled.instructions.map(ix => ix.data)).toEqual(compacted.map(ix => ix.data));
  });
  it("fits the captured real sequential fallback and preserves every instruction and signer", () => {
    const ixs = compactFixture.instructions.map(ix => new TransactionInstruction({ programId: new PublicKey(ix.program),
      data: Buffer.from(ix.data, "base64"), keys: ix.accounts.map(([address, flags]) => ({ pubkey: new PublicKey(address as string),
        isSigner: Boolean((flags as number) & 1), isWritable: Boolean((flags as number) & 2) })),
    }));
    const alts = compactFixture.tables.map(table => new AddressLookupTableAccount({ key: new PublicKey(table.key), state: {
      deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: Array.from({ length: table.length }, (_, index) => new PublicKey(
      table.entries.find(entry => entry[0] === index)?.[1] as string ?? PublicKey.default.toBase58())),
    } }));
    const compact = compileCompactOpenTransaction({ payerKey: new PublicKey(compactFixture.payer), recentBlockhash: compactFixture.blockhash, instructions: ixs }, alts);
    expect(assertOpenTransactionSize(compact.transaction)).toBeLessThanOrEqual(1232);
    expect(versionedTransactionSize(compact.transaction)).toBe(compact.transaction.serialize().length);
    expect(compact.transaction.message.header.numRequiredSignatures).toBe(2);
    const decoded = TransactionMessage.decompile(compact.transaction.message, { addressLookupTableAccounts: compact.tables });
    const content = (list: TransactionInstruction[]) => list.map(ix => ({ program: ix.programId.toBase58(),
      accounts: ix.keys.map(key => key.pubkey.toBase58()), data: ix.data.toString("base64") }));
    expect(content(decoded.instructions)).toEqual(content(ixs));
    const original = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(compactFixture.payer),
      recentBlockhash: compactFixture.blockhash, instructions: ixs }).compileToV0Message(alts));
    const accountRoles = (transaction: VersionedTransaction, lookupTables: AddressLookupTableAccount[]) => {
      const decoded = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: lookupTables });
      return decoded.instructions.flatMap(ix => ix.keys.map(key => [key.pubkey.toBase58(), key.isSigner, key.isWritable]));
    };
    expect(accountRoles(compact.transaction, compact.tables)).toEqual(accountRoles(original, alts));
  });
  it("finds a smaller overlapping table subset than greedy coverage", () => {
    const payer = Keypair.generate().publicKey, accounts = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
    const table = (indexes: number[]) => new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: {
      deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: indexes.map(index => accounts[index]!),
    } });
    const alts = [table([0, 1, 2, 3]), table([0, 1, 4]), table([2, 3, 5])];
    const message = { payerKey: payer, recentBlockhash: fixture.blockhash, instructions: [new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID, keys: accounts.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })), data: Buffer.alloc(1),
    })] };
    const compact = compileCompactOpenTransaction(message, alts);
    const original = new VersionedTransaction(new TransactionMessage(message).compileToV0Message(alts));
    expect(versionedTransactionSize(compact.transaction)).toBe(versionedTransactionSize(original) - 34);
    expect(compact.tables).toEqual(alts.slice(1));
  });
  it("measures exactly across short-vector boundaries including both signatures", () => {
    const payer = Keypair.generate().publicKey;
    for (const length of [1, 127, 128, 180]) {
      const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: fixture.blockhash,
        instructions: [new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [], data: Buffer.alloc(length) })],
      }).compileToV0Message());
      expect(versionedTransactionSize(transaction)).toBe(transaction.serialize().length);
    }
  });
  it("retains a recreate after a close and keeps transfers distinct", async () => {
    const wallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint, wallet);
    const create = createAssociatedTokenAccountIdempotentInstruction(wallet, ata, wallet, mint);
    const close = createCloseAccountInstruction(ata, wallet, wallet);
    const connection = { getMultipleAccountsInfo: vi.fn(async () => [null]) };
    expect(await compactAtaInstructions(connection as never, [create, create, close, create])).toEqual([create, close, create]);
  });
});
