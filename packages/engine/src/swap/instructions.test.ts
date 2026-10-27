import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { AddressLookupTableAccount, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
import { JUPITER_PROGRAM_ID, rejectUnselectedWalletTokenWrites, transactionIntermediateAccounts, verifyIntermediateAccounts } from "./instructions";
const key = () => Keypair.generate().publicKey;
function fixture(program = TOKEN_PROGRAM_ID) {
  const wallet = key(), address = key(), mint = key();
  const data = Buffer.alloc(program.equals(TOKEN_2022_PROGRAM_ID) ? 166 : 165);
  mint.toBuffer().copy(data); wallet.toBuffer().copy(data, 32); data.writeBigUInt64LE(9_000_000n, 64); data[108] = 1;
  if (data.length > 165) data[165] = 2;
  const info = { data, owner: program, lamports: 2039280, executable: false, rentEpoch: 0 };
  const connection = { getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 123 }, value: keys.map(k => k.equals(address) ? info : null) })) } as unknown as Connection;
  const ix = (programId = JUPITER_PROGRAM_ID, isWritable = true) => new TransactionInstruction({ programId, keys: [{ pubkey: address, isWritable, isSigner: false }] });
  const post = (amount: bigint) => { const bytes = Buffer.from(data); bytes.writeBigUInt64LE(amount, 64); return { ...info, owner: program.toBase58(), data: [bytes.toString("base64"), "base64"] }; };
  return { wallet, address, mint, info, connection, ix, post };
}
it.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])("protects funded Jupiter intermediates for program %s", async program => {
  const f = fixture(program);
  const result = await rejectUnselectedWalletTokenWrites(f.connection, f.wallet, [f.ix(), f.ix(), f.ix(SystemProgram.programId, false)], []);
  expect(result.slot).toBe(123); expect(result.accounts).toHaveLength(1);
  const addresses = [f.address.toBase58()];
  for (const amount of [9_000_000n, 9_000_001n]) expect(() => verifyIntermediateAccounts(result.accounts, addresses, [f.post(amount)], f.wallet)).not.toThrow();
  for (const after of [null, f.post(8_999_999n), { ...f.post(9_000_000n), owner: SystemProgram.programId.toBase58() }, { ...f.post(9_000_000n), data: ["", "base64"] }]) {
    expect(() => verifyIntermediateAccounts(result.accounts, addresses, [after], f.wallet)).toThrow(f.address.toBase58());
  }
  expect(() => verifyIntermediateAccounts(result.accounts, addresses, undefined, f.wallet)).toThrow();
  for (const offset of [0, 32]) {
    const data = Buffer.from(f.info.data); key().toBuffer().copy(data, offset);
    expect(() => verifyIntermediateAccounts(result.accounts, addresses, [{ ...f.post(9_000_000n), data: [data.toString("base64"), "base64"] }], f.wallet)).toThrow();
  }
});
it("rejects any non-Jupiter writable use, even alongside a Jupiter route", async () => {
  const f = fixture();
  await expect(rejectUnselectedWalletTokenWrites(f.connection, f.wallet, [f.ix(), f.ix(SystemProgram.programId)], [])).rejects.toThrow(f.address.toBase58());
  expect((await rejectUnselectedWalletTokenWrites(f.connection, f.wallet, [f.ix(SystemProgram.programId)], [f.address.toBase58()])).accounts).toEqual([]);
});
it("ignores empty accounts and external vaults, but fails on incomplete RPC results", async () => {
  const f = fixture(); f.info.data.writeBigUInt64LE(0n, 64);
  expect((await rejectUnselectedWalletTokenWrites(f.connection, f.wallet, [f.ix()], [])).accounts).toEqual([]);
  f.info.data.writeBigUInt64LE(9n, 64); key().toBuffer().copy(f.info.data, 32);
  expect((await rejectUnselectedWalletTokenWrites(f.connection, f.wallet, [f.ix()], [])).accounts).toEqual([]);
  vi.mocked(f.connection.getMultipleAccountsInfoAndContext).mockResolvedValue({ context: { slot: 1 }, value: [] });
  await expect(rejectUnselectedWalletTokenWrites(f.connection, f.wallet, [f.ix()], [])).rejects.toThrow("could not be verified");
});
it("discovers intermediates from actual ALT instructions for signed re-simulation", async () => {
  const f = fixture();
  const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: [f.address] } });
  f.connection.getAddressLookupTable = vi.fn(async () => ({ context: { slot: 123 }, value: table }));
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: f.wallet, recentBlockhash: key().toBase58(), instructions: [f.ix()] }).compileToV0Message([table]));
  expect(transaction.message.addressTableLookups).toHaveLength(1);
  expect((await transactionIntermediateAccounts(f.connection, transaction, f.wallet, [])).accounts[0]?.address).toBe(f.address.toBase58());
  const mixed = new VersionedTransaction(new TransactionMessage({ payerKey: f.wallet, recentBlockhash: key().toBase58(), instructions: [f.ix(), f.ix(SystemProgram.programId)] }).compileToV0Message([table]));
  await expect(transactionIntermediateAccounts(f.connection, mixed, f.wallet, [])).rejects.toThrow(f.address.toBase58());
  vi.mocked(f.connection.getAddressLookupTable).mockResolvedValue({ context: { slot: 123 }, value: null });
  await expect(transactionIntermediateAccounts(f.connection, transaction, f.wallet, [])).rejects.toThrow("lookup table unavailable");
});
