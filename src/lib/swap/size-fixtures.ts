// Offline envelopes: captured instruction shapes, dummy recipient/route keys and ALTs.
import "@/lib/engine-host";
import { AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createInitializeAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import openFixture from "../fixtures/open-size-compact-route.json";
import compoundFixture from "../fixtures/compound-size-route.json";
import { compileCompactOpenTransaction, versionedTransactionSize } from "@sofinance/engine/open-transaction";
import { USDC_MINT } from "@sofinance/engine/ids";
import { exceedsTxSizeLimit, SOLANA_TX_SIZE_LIMIT } from "@sofinance/engine/transaction-limits";
import { BEAM_MIN_TIP_LAMPORTS } from "@sofinance/engine/solami-beam";
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
  measure("open SOL sequential + USDC fee route / ATA exists", open, [...open.instructions, of.route], [of.table]);
  measure("open SOL sequential + USDC fee route / ATA missing", open, [...open.instructions, of.create, of.route], [of.table]);
  measure("open single leg + USDC fee route / ATA exists", open, [...open.instructions.filter((_, i) => i !== 7), of.route], [of.table]);
  measure("open single leg + USDC fee route / ATA missing", open, [...open.instructions.filter((_, i) => i !== 7), of.create, of.route], [of.table]);
  measure("open SOL sequential input fallback", open, [...open.instructions, SystemProgram.transfer({ fromPubkey: open.payer, toPubkey: key(239), lamports: 1000 })]);
  const tokenOpen = open.instructions.filter((_, i) => ![1, 2, 3, 7, 9].includes(i));
  measure("open pool-token + USDC fee route / ATA exists", open, [...tokenOpen, of.route], [of.table]);
  measure("open pool-token + USDC fee route / ATA missing", open, [...tokenOpen, of.create, of.route], [of.table]);
  // Selected add needs no NFT signer/mint, and uses the 42-byte increase form.
  const add = new TransactionInstruction({ programId: open.instructions[8]!.programId, data: Buffer.alloc(42),
    keys: open.instructions[8]!.keys.filter(k => !k.isSigner || k.pubkey.equals(open.payer)).slice(0, 16) });
  const selected = [...open.instructions.slice(0, 8), add, open.instructions[9]!];
  measure("selected SOL + USDC fee route / ATA exists", open, [...selected, of.route], [of.table]);
  measure("selected SOL + USDC fee route / ATA missing", open, [...selected, of.create, of.route], [of.table]);
  const tokenSelected = selected.filter((_, i) => ![1, 2, 3, 7, 9].includes(i));
  measure("selected pool-token + USDC fee route / ATA exists", open, [...tokenSelected, of.route], [of.table]);
  measure("selected pool-token + USDC fee route / ATA missing", open, [...tokenSelected, of.create, of.route], [of.table]);
  const compact = compound.instructions.map((ix, i) => [2, 4].includes(i)
    ? createInitializeAccountInstruction(ix.keys[0]!.pubkey, ix.keys[1]!.pubkey, compound.payer, ix.programId) : ix);
  const cf = fee(compound);
  // Remove existing input-token fee ATA setup. Existing input-token fallback
  // also removes its creation, retaining the original checked transfer.
  const existing = compact.filter((_, i) => i !== 7);
  measure("compound input-token fallback / ATA exists", compound, existing);
  measure("compound input-token fallback / ATA missing", compound, compact);
  const noFee = compact.filter((_, i) => ![7, 8].includes(i));
  measure("compound + USDC fee route / ATA exists", compound, [...noFee, cf.route], [cf.table]);
  measure("compound + USDC fee route / ATA missing", compound, [...noFee, cf.create, cf.route], [cf.table]);
  measure("exit USDC platform fee / ATA exists", open, [open.instructions[0]!, of.route], [of.table]);
  measure("exit USDC platform fee / ATA missing", open, [open.instructions[0]!, of.create, of.route], [of.table]);
  return rows;
}

const HOOD_PREVIEW_BYTES = 1068;
const HOOD_HIGH_PREVIEW_BYTES = 1165;

function padInstructionData(instructions: TransactionInstruction[], extra: number) {
  const copy = instructions.map((ix) => new TransactionInstruction({
    programId: ix.programId, keys: ix.keys, data: Buffer.from(ix.data),
  }));
  const index = copy.reduce((best, ix, current) => ix.data.length >= copy[best]!.data.length ? current : best, 0);
  const ix = copy[index]!;
  copy[index] = new TransactionInstruction({
    programId: ix.programId, keys: ix.keys,
    data: Buffer.concat([ix.data, Buffer.alloc(Math.max(0, extra))]),
  });
  return copy;
}

function compileNaive(
  payer: PublicKey, blockhash: string, instructions: TransactionInstruction[], tables: AddressLookupTableAccount[],
) {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash, instructions,
  }).compileToV0Message(tables));
}

function measureCompiled(flow: string, tx: VersionedTransaction) {
  const bytes = versionedTransactionSize(tx);
  let serialized = false;
  try {
    if (tx.serialize().length !== bytes) throw new Error("Size calculation mismatch");
    serialized = true;
  } catch (error) {
    if (!exceedsTxSizeLimit(bytes)) throw error;
  }
  return { flow, bytes, fits: !exceedsTxSizeLimit(bytes), serialized };
}

/** Preview-sized SPCX→HOOD selected-add envelopes with production fee + Beam tip overlays. */
export function selectedHoodSizeFixtures() {
  const open = decode(openFixture);
  const add = new TransactionInstruction({
    programId: open.instructions[8]!.programId, data: Buffer.alloc(42),
    keys: open.instructions[8]!.keys.filter((k) => !k.isSigner || k.pubkey.equals(open.payer)).slice(0, 16),
  });
  const selected = [...open.instructions.slice(0, 8), add, open.instructions[9]!];
  const tokenSelected = selected.filter((_, i) => ![1, 2, 3, 7, 9].includes(i));
  const mint = new PublicKey(USDC_MINT);
  const recipient = key(239);
  const feeAta = getAssociatedTokenAddressSync(mint, recipient, true);
  const feeTransfer = createTransferCheckedInstruction(key(238), mint, feeAta, open.payer, 1000n, 6);
  const tip = SystemProgram.transfer({ fromPubkey: open.payer, toPubkey: key(240), lamports: BEAM_MIN_TIP_LAMPORTS });
  const protocolTable = new AddressLookupTableAccount({
    key: key(236),
    state: {
      deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
      addresses: [feeAta, key(240), key(238)],
    },
  });

  function sized(target: number) {
    const baseline = compileNaive(open.payer, open.blockhash, tokenSelected, open.tables);
    const extra = Math.max(0, target - versionedTransactionSize(baseline));
    return padInstructionData(tokenSelected, extra);
  }

  const hood = sized(HOOD_PREVIEW_BYTES);
  const hoodHigh = sized(HOOD_HIGH_PREVIEW_BYTES);
  const rows: { flow: string; bytes: number; fits: boolean; serialized: boolean }[] = [];

  function record(flow: string, instructions: TransactionInstruction[], tables: AddressLookupTableAccount[], compact = false) {
    const tx = compact
      ? compileCompactOpenTransaction({ payerKey: open.payer, recentBlockhash: open.blockhash, instructions }, tables).transaction
      : compileNaive(open.payer, open.blockhash, instructions, tables);
    rows.push(measureCompiled(flow, tx));
  }

  record("selected SPCX→HOOD preview (no fee, no tip)", hood, open.tables);
  record("selected SPCX→HOOD production fee+tip naive", [...hood, feeTransfer, tip], open.tables);
  record("selected SPCX→HOOD production fee only (skip tip)", [...hood, feeTransfer], open.tables);
  record("selected SPCX→HOOD production fee+tip compact ALT", [...hood, feeTransfer, tip], [...open.tables, protocolTable], true);
  record("selected SPCX→HOOD-high preview (no fee, no tip)", hoodHigh, open.tables);
  record("selected SPCX→HOOD-high production fee+tip naive", [...hoodHigh, feeTransfer, tip], open.tables);
  record("selected SPCX→HOOD-high production fee only (skip tip)", [...hoodHigh, feeTransfer], open.tables);
  record("selected SPCX→HOOD-high production fee+tip compact ALT", [...hoodHigh, feeTransfer, tip], [...open.tables, protocolTable], true);
  return rows;
}

export function selectedHoodSizeSavings(rows = selectedHoodSizeFixtures()) {
  const bytes = (flow: string) => rows.find((row) => row.flow === flow)!.bytes;
  return {
    hoodPreview: bytes("selected SPCX→HOOD preview (no fee, no tip)"),
    hoodProductionNaive: bytes("selected SPCX→HOOD production fee+tip naive"),
    hoodSkipTip: bytes("selected SPCX→HOOD production fee only (skip tip)"),
    hoodCompactAlt: bytes("selected SPCX→HOOD production fee+tip compact ALT"),
    hoodHighPreview: bytes("selected SPCX→HOOD-high preview (no fee, no tip)"),
    hoodHighProductionNaive: bytes("selected SPCX→HOOD-high production fee+tip naive"),
    hoodHighSkipTip: bytes("selected SPCX→HOOD-high production fee only (skip tip)"),
    hoodHighCompactAlt: bytes("selected SPCX→HOOD-high production fee+tip compact ALT"),
    limit: SOLANA_TX_SIZE_LIMIT,
  };
}
