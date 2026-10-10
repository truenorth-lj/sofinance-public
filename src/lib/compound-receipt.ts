import { createHash } from "node:crypto";
import bs58 from "bs58";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction, TokenBalance } from "@solana/web3.js";
import type { CompoundSummary } from "./compound-types";
import type { CompoundRecoverySummary } from "./compound-recovery-types";

const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
function u128(data: Buffer, offset: number) { return data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n); }

function tokenRecord(transaction: ParsedTransactionWithMeta, address: string, records: TokenBalance[] | null | undefined) {
  const index = transaction.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === address);
  return records?.find((record) => record.accountIndex === index);
}

function transferred(transaction: ParsedTransactionWithMeta, parent: number, source: string, destination: string) {
  let total = 0n;
  for (const instruction of transaction.meta?.innerInstructions?.find((group) => group.index === parent)?.instructions || []) {
    if (!("parsed" in instruction)) continue;
    const parsed = instruction.parsed as { type?: string; info?: Record<string, unknown> };
    if (parsed.type !== "transferChecked" && parsed.type !== "transfer") continue;
    const info = parsed.info;
    if (!info || info.source !== source || info.destination !== destination) continue;
    const tokenAmount = info.tokenAmount as { amount?: unknown } | undefined;
    const amount = tokenAmount?.amount ?? info.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) throw new Error("On-chain yield transfer amount cannot be verified");
    total += BigInt(amount);
  }
  return total;
}

/** Derive the ledger from this transaction, never from a newer wallet balance. */
export function confirmedCompoundReceipt(transaction: ParsedTransactionWithMeta, wallet: string, summary: CompoundSummary) {
  const message = transaction.transaction.message;
  if (summary.state.programId !== CLMM_PROGRAM_ID.toBase58() || !transaction.meta || transaction.meta.err || !message.accountKeys[0]?.signer ||
    message.accountKeys[0].pubkey.toBase58() !== wallet) return null;
  const protocol = message.instructions.flatMap((instruction, index) =>
    instruction.programId.toBase58() === summary.state.programId && "accounts" in instruction
      ? [{ instruction: instruction as PartiallyDecodedInstruction, index }] : []);
  const harvest = protocol[0], add = protocol.at(-1);
  const swaps = protocol.slice(1, -1);
  if (protocol.length !== 2 + (summary.swaps?.length ?? 0) || !harvest || !add || harvest.index >= add.index) return null;
  const harvestedData = Buffer.from(bs58.decode(harvest.instruction.data));
  const addedData = Buffer.from(bs58.decode(add.instruction.data));
  if (harvestedData.length !== 40 || !harvestedData.subarray(0, 8).equals(discriminator("decrease_liquidity_v2")) ||
    u128(harvestedData, 8) !== 0n || addedData.length !== 42 ||
    !addedData.subarray(0, 8).equals(discriminator("increase_liquidity_v2")) ||
    u128(addedData, 8) !== BigInt(summary.liquidity) || BigInt(summary.liquidity) <= 0n ||
    addedData.readBigUInt64LE(24) !== BigInt(summary.amountMaxA) || addedData.readBigUInt64LE(32) !== BigInt(summary.amountMaxB)) return null;
  const matches = (instruction: PartiallyDecodedInstruction, index: number, address: string) => instruction.accounts[index]?.toBase58() === address;
  if (!matches(harvest.instruction, 0, wallet) || !matches(add.instruction, 0, wallet) ||
    !matches(harvest.instruction, 1, summary.state.nftAta) || !matches(add.instruction, 1, summary.state.nftAta) ||
    !matches(harvest.instruction, 2, summary.positionAccount) || !matches(add.instruction, 4, summary.positionAccount) ||
    !matches(harvest.instruction, 3, summary.poolId) || !matches(add.instruction, 2, summary.poolId)) return null;
  const nftAfter = tokenRecord(transaction, summary.state.nftAta, transaction.meta.postTokenBalances);
  if (!nftAfter || nftAfter.mint !== summary.positionMint || nftAfter.owner !== wallet || nftAfter.uiTokenAmount.amount !== "1") return null;
  const swapLedger = swaps.map((entry, index) => {
    const approved = summary.swaps?.[index];
    if (!approved) return null;
    const data = Buffer.from(bs58.decode(entry.instruction.data));
    const input = summary.compoundAccounts.find((account) => account.mint === approved.inputMint);
    const output = summary.compoundAccounts.find((account) => account.mint === approved.outputMint);
    if (!input || !output || input === output || approved.poolId !== summary.poolId ||
      data.length !== 41 || !data.subarray(0, 8).equals(discriminator("swap_v2")) ||
      data.readBigUInt64LE(8) !== BigInt(approved.inputAmount) || data.readBigUInt64LE(16) !== BigInt(approved.minOutputAmount) || data[40] !== 1 ||
      !matches(entry.instruction, 0, wallet) || !matches(entry.instruction, 2, summary.poolId) ||
      !matches(entry.instruction, 3, input.address) || !matches(entry.instruction, 4, output.address) ||
      !matches(entry.instruction, 11, input.mint) || !matches(entry.instruction, 12, output.mint)) return null;
    const inputVault = input === summary.compoundAccounts[0] ? summary.state.vaultA : summary.state.vaultB;
    const outputVault = output === summary.compoundAccounts[0] ? summary.state.vaultA : summary.state.vaultB;
    if (!matches(entry.instruction, 5, inputVault) || !matches(entry.instruction, 6, outputVault)) return null;
    const spent = transferred(transaction, entry.index, input.address, inputVault);
    const received = transferred(transaction, entry.index, outputVault, output.address);
    if (spent !== BigInt(approved.inputAmount) || received < BigInt(approved.minOutputAmount)) return null;
    return { input: input.address, output: output.address, spent, received,
      inputMint: input.mint, outputMint: output.mint };
  });
  if (swapLedger.some((swap) => !swap)) return null;
  for (const source of summary.priorSources ?? []) {
    const before = tokenRecord(transaction, source.address, transaction.meta.preTokenBalances);
    if (!before || before.owner !== wallet || before.mint !== source.mint || before.programId !== source.program ||
      before.uiTokenAmount.amount !== source.amount || tokenRecord(transaction, source.address, transaction.meta.postTokenBalances)) return null;
    const transfer = message.instructions.some((instruction) => "parsed" in instruction && instruction.programId.toBase58() === source.program &&
      instruction.parsed.type === "transferChecked" && instruction.parsed.info?.source === source.address &&
      instruction.parsed.info?.destination === source.destination && instruction.parsed.info?.authority === wallet &&
      instruction.parsed.info?.tokenAmount?.amount === source.amount);
    const closed = message.instructions.some((instruction) => "parsed" in instruction && instruction.programId.toBase58() === source.program &&
      instruction.parsed.type === "closeAccount" && instruction.parsed.info?.account === source.address &&
      instruction.parsed.info?.destination === wallet && instruction.parsed.info?.owner === wallet);
    if (!closed || source.amount !== "0" && !transfer) return null;
  }
  const ledger = summary.compoundAccounts.map((account, index) => {
    if (!matches(harvest.instruction, 9 + index, account.address) || !matches(add.instruction, 7 + index, account.address)) return null;
    if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(account.program)) return null;
    const prior = tokenRecord(transaction, account.address, transaction.meta?.preTokenBalances);
    const after = tokenRecord(transaction, account.address, transaction.meta?.postTokenBalances);
    if (prior && prior.uiTokenAmount.amount !== "0" || !after || after.owner !== wallet || after.mint !== account.mint || after.programId !== account.program) return null;
    const vault = index === 0 ? summary.state.vaultA : summary.state.vaultB;
    const harvestedFees = transferred(transaction, harvest.index, vault, account.address);
    const harvestedRewards = summary.state.rewards.filter((reward) => reward.mint === account.mint)
      .reduce((sum, reward) => sum + transferred(transaction, harvest.index, reward.vault, account.address), 0n);
    const invested = transferred(transaction, add.index, account.address, vault);
    const priorYield = (summary.priorSources ?? []).filter((source) => source.destination === account.address && source.mint === account.mint && source.program === account.program)
      .reduce((sum, source) => sum + BigInt(source.amount), 0n);
    const swapInput = swapLedger.filter((swap) => swap?.input === account.address).reduce((sum, swap) => sum + swap!.spent, 0n);
    const swapOutput = swapLedger.filter((swap) => swap?.output === account.address).reduce((sum, swap) => sum + swap!.received, 0n);
    const remaining = BigInt(after.uiTokenAmount.amount);
    const protocolFee = (summary.swaps ?? [])
      .filter((item) => item.inputMint === account.mint)
      .reduce((sum, item) => sum + BigInt(item.feeAmount ?? "0"), 0n);
    if (protocolFee > 0n) {
      const paid = message.instructions.some((instruction) => {
        if (!("parsed" in instruction) || instruction.programId.toBase58() !== account.program) return false;
        const parsed = instruction.parsed as { type?: string; info?: { source?: string; destination?: string; authority?: string; tokenAmount?: { amount?: string } } };
        const destination = parsed.info?.destination;
        return parsed.type === "transferChecked" && parsed.info?.source === account.address && parsed.info.authority === wallet
          && parsed.info.tokenAmount?.amount === protocolFee.toString()
          && destination !== summary.compoundAccounts[0].address && destination !== summary.compoundAccounts[1].address;
      });
      if (!paid) return null;
    }
    if (invested > BigInt(index === 0 ? summary.amountMaxA : summary.amountMaxB) ||
      harvestedFees + harvestedRewards + priorYield + swapOutput - swapInput - invested - protocolFee !== remaining) return null;
    return { harvested: (harvestedFees + harvestedRewards).toString(), fees: harvestedFees.toString(),
      rewards: harvestedRewards.toString(), priorYield: priorYield.toString(), swapInput: swapInput.toString(), swapOutput: swapOutput.toString(),
      invested: invested.toString(), remaining: remaining.toString() };
  });
  if (!ledger[0] || !ledger[1]) return null;
  const rewards = summary.state.rewards.filter((reward) => !reward.compounded).map((reward) => ({
    mint: reward.mint, amount: transferred(transaction, harvest.index, reward.vault, reward.account).toString(), compounded: false,
  }));
  if (summary.swaps !== undefined && rewards.some((reward) => BigInt(reward.amount) > 0n)) return null;
  return { harvestedA: ledger[0].harvested, harvestedB: ledger[1].harvested,
    investedA: ledger[0].invested, investedB: ledger[1].invested,
    remainingA: ledger[0].remaining, remainingB: ledger[1].remaining, rewards,
    priorYieldA: ledger[0].priorYield, priorYieldB: ledger[1].priorYield,
    swaps: swapLedger.map((swap) => ({ inputMint: swap!.inputMint, outputMint: swap!.outputMint,
      inputAmount: swap!.spent.toString(), outputAmount: swap!.received.toString() })),
    liquidityAdded: summary.liquidity, feeLamports: transaction.meta.fee };
}

export function confirmedRecovery(transaction: ParsedTransactionWithMeta, wallet: string, summary: CompoundRecoverySummary) {
  const message = transaction.transaction.message;
  if (!transaction.meta || transaction.meta.err || message.accountKeys[0]?.pubkey.toBase58() !== wallet || !message.accountKeys[0]?.signer) return false;
  return summary.compoundAccounts.every((account) => {
    const before = tokenRecord(transaction, account.address, transaction.meta?.preTokenBalances);
    const after = tokenRecord(transaction, account.address, transaction.meta?.postTokenBalances);
    if (!before || before.mint !== account.mint || before.owner !== wallet || before.uiTokenAmount.amount !== account.amount || after) return false;
    const transfer = message.instructions.find((instruction) => {
      if (!("parsed" in instruction) || instruction.programId.toBase58() !== account.program) return false;
      const parsed = instruction.parsed as { type?: string; info?: { source?: string; destination?: string; authority?: string; tokenAmount?: { amount?: string } } };
      return parsed.type === "transferChecked" && parsed.info?.source === account.address && parsed.info.destination === account.destination &&
        parsed.info.authority === wallet && parsed.info.tokenAmount?.amount === account.amount;
    });
    const close = message.instructions.find((instruction) => {
      if (!("parsed" in instruction) || instruction.programId.toBase58() !== account.program) return false;
      const parsed = instruction.parsed as { type?: string; info?: { account?: string; destination?: string; owner?: string } };
      return parsed.type === "closeAccount" && parsed.info?.account === account.address && parsed.info.destination === wallet && parsed.info.owner === wallet;
    });
    return !!close && (account.amount === "0" || !!transfer);
  });
}
