import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { CompoundReceipt } from "./compound-attempt";

export type ImportedPriorCredit = { address: string; mint: string; program: string; amount: bigint; preAmount: bigint; positionMint: string; poolId: string; positionAccount: string };
export type CompoundImportOptions = { verifyYield?: boolean; verifyPriorCredit?: (credit: ImportedPriorCredit) => Promise<void> };

function checkedAmount(instruction: ParsedInstruction) {
  const info = instruction.parsed.info as Record<string, unknown> | undefined;
  const amount = (info?.tokenAmount as { amount?: unknown } | undefined)?.amount ?? info?.amount;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) throw new Error("Yield transfer amount cannot be verified");
  return BigInt(amount);
}

/** Prove every credit into isolated sources; their creation alone is not yield proof. */
export async function verifyImportedYieldLedger(transaction: ParsedTransactionWithMeta, receipt: CompoundReceipt,
  protocol: { instruction: PartiallyDecodedInstruction; index: number }[], options: CompoundImportOptions) {
  const harvest = protocol[0]!, add = protocol[protocol.length - 1]!, swap = protocol.length === 3 ? protocol[1] : undefined;
  const accounts = receipt.compoundAccounts;
  const rewardStart = harvest.instruction.accounts.length % 3 === 1 ? 16 : 17;
  if (harvest.instruction.accounts.length < rewardStart || (harvest.instruction.accounts.length - rewardStart) % 3 !== 0) throw new Error("Yield reward accounts mismatch");
  const incoming = [0n, 0n], outgoing = [0n, 0n];
  const records = transaction.meta!.postTokenBalances;
  for (const [index, account] of accounts.entries()) {
    const addressIndex = transaction.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === account.address);
    const before = transaction.meta!.preTokenBalances?.find((record) => record.accountIndex === addressIndex);
    if (before && before.uiTokenAmount.amount !== "0") throw new Error("New yield account already has existing assets");
    const after = records?.find((record) => record.accountIndex === addressIndex);
    if (!after || after.owner !== receipt.wallet || after.mint !== account.mint || after.programId !== account.program || !/^\d+$/.test(after.uiTokenAmount.amount)) throw new Error("Yield post balance identity cannot be verified");
    const vault = harvest.instruction.accounts[5 + index]?.toBase58();
    if (!vault || add.instruction.accounts[9 + index]?.toBase58() !== vault || harvest.instruction.accounts[14 + index]?.toBase58() !== account.mint || add.instruction.accounts[13 + index]?.toBase58() !== account.mint) throw new Error("Yield vault or mint mismatch");
  }
  if (swap) {
    const ix = swap.instruction, bytes = Buffer.from(bs58.decode(ix.data));
    const input = accounts.findIndex((account) => account.address === ix.accounts[3]?.toBase58());
    const output = accounts.findIndex((account) => account.address === ix.accounts[4]?.toBase58());
    if (bytes.length !== 41 || bytes[40] !== 1 || bytes.readBigUInt64LE(8) === 0n || bytes.readBigUInt64LE(16) === 0n || input < 0 || output < 0 || input === output ||
      ix.accounts[0]?.toBase58() !== receipt.wallet || ix.accounts[2]?.toBase58() !== harvest.instruction.accounts[3]?.toBase58() ||
      ix.accounts[5]?.toBase58() !== harvest.instruction.accounts[5 + input]?.toBase58() || ix.accounts[6]?.toBase58() !== harvest.instruction.accounts[5 + output]?.toBase58() ||
      ix.accounts[11]?.toBase58() !== accounts[input]!.mint || ix.accounts[12]?.toBase58() !== accounts[output]!.mint) throw new Error("Yield swap not restricted to original pool and isolated yield accounts");
  }
  const transfers = [
    ...transaction.transaction.message.instructions.map((instruction, parent) => ({ instruction, parent, topLevel: true })),
    ...(transaction.meta!.innerInstructions ?? []).flatMap((group) => group.instructions.map((instruction) => ({ instruction, parent: group.index, topLevel: false }))),
  ];
  for (const { instruction, parent, topLevel } of transfers) {
    if (!("parsed" in instruction) || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(instruction.programId.toBase58()) || !["transfer", "transferChecked"].includes(instruction.parsed.type)) continue;
    const info = instruction.parsed.info as Record<string, unknown>;
    const from = accounts.findIndex((account) => account.address === info.source), to = accounts.findIndex((account) => account.address === info.destination);
    if (from < 0 && to < 0) continue;
    const amount = checkedAmount(instruction);
    if (from >= 0 && to >= 0) throw new Error("Cannot treat inter-yield-account transfers as new yield");
    const index = from >= 0 ? from : to, account = accounts[index]!;
    if (instruction.programId.toBase58() !== account.program || instruction.parsed.type === "transferChecked" && info.mint !== account.mint) throw new Error("Yield transfer program or mint mismatch");
    let proven = false;
    if (!topLevel && parent === harvest.index && to >= 0) {
      const vaults = [harvest.instruction.accounts[5 + index]!.toBase58()];
      for (let offset = rewardStart; offset < harvest.instruction.accounts.length; offset += 3) {
        if (harvest.instruction.accounts[offset + 1]?.toBase58() === account.address && harvest.instruction.accounts[offset + 2]?.toBase58() === account.mint) vaults.push(harvest.instruction.accounts[offset]!.toBase58());
      }
      proven = vaults.includes(String(info.source));
    } else if (!topLevel && parent === add.index && from >= 0) {
      proven = info.destination === add.instruction.accounts[9 + index]!.toBase58() && info.authority === receipt.wallet;
    } else if (!topLevel && swap && parent === swap.index) {
      proven = from >= 0 ? info.destination === swap.instruction.accounts[5]?.toBase58() && info.authority === receipt.wallet : info.source === swap.instruction.accounts[6]?.toBase58();
    } else if (topLevel && parent < harvest.index && to >= 0 && instruction.parsed.type === "transferChecked" && info.authority === receipt.wallet) {
      if (!options.verifyPriorCredit || typeof info.source !== "string") throw new Error("Original yield import lacks provable historical source");
      const sourceIndex = transaction.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === info.source);
      const before = transaction.meta!.preTokenBalances?.find((record) => record.accountIndex === sourceIndex);
      if (!before || before.owner !== receipt.wallet || before.mint !== account.mint || before.programId !== account.program || !/^\d+$/.test(before.uiTokenAmount.amount) || BigInt(before.uiTokenAmount.amount) !== amount) throw new Error("Original yield import does not match source pre balance");
      await options.verifyPriorCredit({ address: info.source, mint: account.mint, program: account.program, amount, preAmount: BigInt(before.uiTokenAmount.amount),
        positionMint: receipt.positionMint, poolId: harvest.instruction.accounts[3]!.toBase58(), positionAccount: harvest.instruction.accounts[2]!.toBase58() });
      proven = true;
    }
    if (!proven) throw new Error("Yield account contains unprovable existing asset transfer");
    if (to >= 0) incoming[to]! += amount;
    if (from >= 0) outgoing[from]! += amount;
  }
  for (const [index, account] of accounts.entries()) {
    const addressIndex = transaction.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === account.address);
    const remaining = BigInt(records!.find((record) => record.accountIndex === addressIndex)!.uiTokenAmount.amount);
    if (incoming[index]! - outgoing[index]! !== remaining) throw new Error("Yield source does not match original transaction remaining amount");
  }
}
