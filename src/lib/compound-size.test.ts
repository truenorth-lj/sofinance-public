import { AddressLookupTableAccount, PublicKey, SystemInstruction, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { decodeInitializeAccountInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/compound-size-route.json";
vi.mock("server-only", () => ({}));
import { assertCompoundTransactionSize, createCompoundAccountInstructions } from "./compound-atomic";
import { versionedTransactionSize } from "./open-transaction";

// Captured SPCX instruction/ALT shape with synthetic wallet, pool and mints.
const original = fixture.instructions.map(ix => new TransactionInstruction({
  programId: new PublicKey(ix.program), data: Buffer.from(ix.data, "base64"),
  keys: ix.accounts.map(([address, flags]) => ({ pubkey: new PublicKey(address as string),
    isSigner: Boolean((flags as number) & 1), isWritable: Boolean((flags as number) & 2) })),
}));
const tables = fixture.tables.map(table => new AddressLookupTableAccount({ key: new PublicKey(table.key), state: {
  deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
  addresses: Array.from({ length: table.length }, (_, index) => new PublicKey(
    table.entries.find(entry => entry[0] === index)?.[1] as string ?? PublicKey.default.toBase58())),
} }));
const payer = new PublicKey(fixture.payer);
const compile = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({
  payerKey: payer, recentBlockhash: fixture.blockhash, instructions,
}).compileToV0Message(tables));

describe("atomic compound packet limit", () => {
  it("reproduces the 1268-byte rejected packet and fits both isolated account initializations without changing financial instructions", () => {
    expect(versionedTransactionSize(compile(original))).toBe(1268);
    expect(() => assertCompoundTransactionSize(compile(original))).toThrow("1268 bytes, exceeds 1,232 byte limit");
    const compact: TransactionInstruction[] = [];
    for (let index = 0; index < original.length; index++) {
      const ix = original[index]!;
      if (!ix.programId.equals(SystemProgram.programId)) { compact.push(ix); continue; }
      const creation = SystemInstruction.decodeCreateWithSeed(ix);
      const initialize = original[++index]!;
      const setup = createCompoundAccountInstructions(payer, {
        seed: creation.seed, address: creation.newAccountPubkey.toBase58(), mint: initialize.keys[1]!.pubkey.toBase58(),
        program: creation.programId.toBase58(), rentLamports: Number(creation.lamports), space: Number(creation.space),
      });
      expect(setup[0]!.data).toEqual(ix.data);
      const decoded = decodeInitializeAccountInstruction(setup[1]!, TOKEN_2022_PROGRAM_ID);
      expect(decoded.keys.account.pubkey.equals(creation.newAccountPubkey)).toBe(true);
      expect(decoded.keys.owner.pubkey.equals(payer)).toBe(true);
      expect(decoded.keys.mint.pubkey.equals(initialize.keys[1]!.pubkey)).toBe(true);
      compact.push(...setup);
    }
    const tx = compile(compact);
    expect(assertCompoundTransactionSize(tx)).toBe(1209);
    expect(tx.serialize().length).toBe(1209);
    expect(Buffer.from(tx.serialize()).toString("base64")).toMatchSnapshot();
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    // Harvest, fee, swap and add retain their exact data, accounts and flags.
    expect(compact.slice(5)).toEqual(original.slice(5));
  });
  it("reports the real size even when web3.js cannot serialize an oversized message", () => {
    const padded = new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(1600) });
    const tx = compile([...original, padded]);
    expect(() => tx.serialize()).toThrow();
    expect(() => assertCompoundTransactionSize(tx)).toThrow(`${versionedTransactionSize(tx)} bytes, exceeds 1,232 byte limit`);
  });
});
