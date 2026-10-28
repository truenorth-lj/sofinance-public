// Offline envelopes: captured instruction shapes, dummy recipient/route keys and ALTs.
import "@/lib/engine-host";
import { AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createInitializeAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import openFixture from "../fixtures/open-size-compact-route.json";
import compoundFixture from "../fixtures/compound-size-route.json";
import { versionedTransactionSize } from "@sofinance/engine/open-transaction";
import { USDC_MINT } from "@sofinance/engine/ids";
import { exceedsTxSizeLimit } from "@sofinance/engine/transaction-limits";
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
function decode(f: typeof openFixture) {
  return { payer: new PublicKey(f.payer), blockhash: f.blockhash,
    instructions: f.instructions.map(ix => new TransactionInstruction({ programId: new PublicKey(ix.program), data: Buffer.from(ix.data, "base64"),
      keys: ix.accounts.map(([address, flags]) => ({ pubkey: new PublicKey(address as string), isSigner: Boolean((flags as number) & 1), isWritable: Boolean((flags as number) & 2) })) })),
    tables: f.tables.map(t => new AddressLookupTableAccount({ key: new PublicKey(t.key), state: { deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: Array.from({ length: t.length }, (_, i) => new PublicKey(t.entries.find(e => e[0] === i)?.[1] as string ?? PublicKey.default.toBase58())) } })),
  };
}
export function feeSizeFixtures() {
  const open = decode(openFixture), compound = decode(compoundFixture);
  const rows: { flow: string; bytes: number; fits: boolean; serialized: boolean }[] = [];
  function measure(flow: string, f: typeof open, instructions: TransactionInstruction[], extra: AddressLookupTableAccount[] = []) {
    const tip = SystemProgram.transfer({ fromPubkey: f.payer, toPubkey: key(240), lamports: 100000 });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: f.payer, recentBlockhash: f.blockhash,
      instructions: [...instructions, tip] }).compileToV0Message([...f.tables, ...extra]));
    const bytes = versionedTransactionSize(tx);
    let serialized = false;
    try { if (tx.serialize().length !== bytes) throw new Error("Size calculation mismatch"); serialized = true; } catch (e) { if (!exceedsTxSizeLimit(bytes)) throw e; }
    rows.push({ flow, bytes, fits: !exceedsTxSizeLimit(bytes), serialized });
  }
  function fee(f: typeof open) {
    const mint = new PublicKey(USDC_MINT), recipient = key(239), ata = getAssociatedTokenAddressSync(mint, recipient, true);
    const create = createAssociatedTokenAccountIdempotentInstruction(f.payer, ata, recipient, mint);
    const transfer = createTransferCheckedInstruction(key(238), mint, ata, f.payer, 1000n, 6);
    // Independent compact Jupiter route shape. Pool accounts can be in an ALT;
    // user/fee recipient keys stay inline, as in a returned real route.
    let i = 150;
    const route = new TransactionInstruction({ programId: open.instructions[7]!.programId, data: Buffer.alloc(39),
      keys: open.instructions[7]!.keys.map((k, index) => ({ ...k,
        pubkey: k.isSigner ? f.payer : index === 2 ? ata : index === 3 ? key(238) : key(i++) })) });
    const table = new AddressLookupTableAccount({ key: key(237), state: { deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: route.keys.filter(k => !k.isSigner && !k.pubkey.equals(ata) && !k.pubkey.equals(key(238))).map(k => k.pubkey) } });
    return { create, transfer, route, table };
  }
  const of = fee(open);
  // USDC does not need native wrap/sync/close. Keep the two captured Jupiter
  // legs and NFT/open envelope, with a single upfront checked transfer.
  const usdcOpen = open.instructions.filter((_, i) => ![1, 2, 3, 9].includes(i));
  measure("open USDC upfront / ATA exists", open, [...usdcOpen, of.transfer]);
  measure("open USDC upfront / ATA missing", open, [...usdcOpen, of.create, of.transfer]);
  measure("open SOL sequential + input-token fee", open, [...open.instructions, SystemProgram.transfer({ fromPubkey: open.payer, toPubkey: key(239), lamports: 1000 })]);
  measure("open single leg + input-token fee / ATA exists", open, [...open.instructions.filter((_, i) => i !== 7), of.transfer]);
  measure("open single leg + input-token fee / ATA missing", open, [...open.instructions.filter((_, i) => i !== 7), of.create, of.transfer]);
  const tokenOpen = open.instructions.filter((_, i) => ![1, 2, 3, 7, 9].includes(i));
  measure("open pool-token + input-token fee / ATA exists", open, [...tokenOpen, of.transfer]);
  measure("open pool-token + input-token fee / ATA missing", open, [...tokenOpen, of.create, of.transfer]);
  // Selected add needs no NFT signer/mint, and uses the 42-byte increase form.
  const add = new TransactionInstruction({ programId: open.instructions[8]!.programId, data: Buffer.alloc(42),
    keys: open.instructions[8]!.keys.filter(k => !k.isSigner || k.pubkey.equals(open.payer)).slice(0, 16) });
  const selected = [...open.instructions.slice(0, 8), add, open.instructions[9]!];
  measure("selected SOL + input-token fee", open, [...selected, SystemProgram.transfer({ fromPubkey: open.payer, toPubkey: key(239), lamports: 1000 })]);
  const tokenSelected = selected.filter((_, i) => ![1, 2, 3, 7, 9].includes(i));
  measure("selected pool-token + input-token fee / ATA exists", open, [...tokenSelected, of.transfer]);
  measure("selected pool-token + input-token fee / ATA missing", open, [...tokenSelected, of.create, of.transfer]);
  const compact = compound.instructions.map((ix, i) => [2, 4].includes(i)
    ? createInitializeAccountInstruction(ix.keys[0]!.pubkey, ix.keys[1]!.pubkey, compound.payer, ix.programId) : ix);
  // Compound already collects as an input-token transfer (create ATA when missing).
  const existing = compact.filter((_, i) => i !== 7);
  measure("compound input-token fee / ATA exists", compound, existing);
  measure("compound input-token fee / ATA missing", compound, compact);
  measure("exit USDC platform fee / ATA exists", open, [open.instructions[0]!, of.route], [of.table]);
  measure("exit USDC platform fee / ATA missing", open, [open.instructions[0]!, of.create, of.route], [of.table]);
  return rows;
}
