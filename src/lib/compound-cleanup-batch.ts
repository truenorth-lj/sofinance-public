import "@/lib/engine-host";
import "server-only";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { readRecoveryAccounts } from "@sofinance/engine/compound-recovery";
import type { CompoundRecoveryAccount, CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { restampVersionedTransaction, stampPreparedBlockhash } from "@sofinance/engine/fresh-blockhash";
import { createPermit } from "@sofinance/engine/auth/permit";
import { SOLANA_TX_SIZE_LIMIT, isSingleWalletSignedTransaction } from "@sofinance/engine/transaction-limits";
import { walletPriorityFeeAllowance } from "@sofinance/engine/wallet-priority-fee";
import { confirmedRecovery } from "./compound-receipt";
import { estimateFeeForMessage } from "./rpc-fee-estimate";
import nacl from "tweetnacl";
import { z } from "zod";
import { withContextSlotRetry } from "@sofinance/engine/rpc/context-slot";

export const MAX_CLEANUP_SOURCES = 64;
const noSources = "No recoverable yield accounts; please verify original compound transaction status first";
const permit = createPermit("sofinance:cleanup-batch:v1");
export const issueCleanupBatchPermit = permit.issue;
export const verifyCleanupBatchPermit = permit.verify;
const key = z.string().min(32).max(44).refine(value => { try { return new PublicKey(value).toBase58() === value; } catch { return false; } });
const safeNonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const descriptorSchema = z.object({ seed: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/), address: key, mint: key,
  program: z.enum([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]),
  space: safeNonnegative.max(16_384), rentLamports: safeNonnegative });
const accountSchema = descriptorSchema.extend({ amount: z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(value => BigInt(value) <= 0xffffffffffffffffn),
  decimals: z.number().int().min(0).max(255), destination: key, sourceLamports: safeNonnegative });
const summarySchema = z.object({ operation: z.literal("recovery"), simulated: z.literal(true), wallet: key,
  compoundAccounts: z.array(accountSchema).min(1).max(MAX_CLEANUP_SOURCES), feeLamports: safeNonnegative.max(10_000_000),
  sizeBytes: z.number().int().positive().max(SOLANA_TX_SIZE_LIMIT), unitsConsumed: safeNonnegative.optional(),
  blockhash: key, lastValidBlockHeight: safeNonnegative.positive(), expiresAt: safeNonnegative.positive(),
  // Engine's stamp includes simulatedAt even though its recovery interface omits it.
  simulatedAt: safeNonnegative.optional() });

export async function parseCleanupBatchSummary(value: unknown, wallet: string): Promise<CompoundRecoverySummary> {
  const summary = summarySchema.parse(value);
  if (summary.wallet !== wallet || new Set(summary.compoundAccounts.map(account => account.address)).size !== summary.compoundAccounts.length) {
    throw new Error("Invalid cleanup wallet or duplicate source");
  }
  for (const account of summary.compoundAccounts) {
    const program = new PublicKey(account.program), owner = new PublicKey(wallet), mint = new PublicKey(account.mint);
    if ((await PublicKey.createWithSeed(owner, account.seed, program)).toBase58() !== account.address ||
      getAssociatedTokenAddressSync(mint, owner, false, program).toBase58() !== account.destination || account.address === account.destination) {
      throw new Error("Invalid cleanup source derivation or recipient");
    }
  }
  return summary;
}

/** Every source is wallet-derived and extension/authority checked by the engine; absent accounts require finalized absence. */
async function readBatchAccounts(connection: Connection, wallet: string, input: unknown) {
  const descriptors = z.array(descriptorSchema).min(1).max(MAX_CLEANUP_SOURCES).parse(input);
  if (new Set(descriptors.map(account => account.address)).size !== descriptors.length) throw new Error("Duplicate cleanup source");
  const accounts: CompoundRecoveryAccount[] = [];
  for (let index = 0; index < descriptors.length; index += 2) {
    try { accounts.push(...await readRecoveryAccounts(connection, wallet, descriptors.slice(index, index + 2))); }
    catch (error) { if (!(error instanceof Error) || error.message !== noSources) throw error; }
  }
  const found = new Set(accounts.map(account => account.address));
  const missing = descriptors.filter(account => !found.has(account.address)).map(account => account.address);
  if (missing.length) {
    const finalized = await connection.getMultipleAccountsInfo(missing.map(address => new PublicKey(address)), "finalized");
    if (finalized.length !== missing.length || finalized.some(info => info !== null)) throw new Error("Cleanup source absence is not finalized; retry later");
  }
  return { accounts, alreadyClosed: missing };
}

function instructionsFor(wallet: PublicKey, accounts: CompoundRecoveryAccount[]) {
  const created = new Set<string>();
  return accounts.flatMap(account => {
    const source = new PublicKey(account.address), mint = new PublicKey(account.mint), program = new PublicKey(account.program);
    const destination = new PublicKey(account.destination);
    const instructions = [];
    if (BigInt(account.amount) > 0n) {
      if (!created.has(account.destination)) {
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, mint, program));
        created.add(account.destination);
      }
      instructions.push(createTransferCheckedInstruction(source, mint, destination, wallet, BigInt(account.amount), account.decimals, [], program));
    }
    instructions.push(createCloseAccountInstruction(source, wallet, wallet, [], program));
    return instructions;
  });
}
function transactionFor(wallet: string, accounts: CompoundRecoveryAccount[], blockhash: string) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(wallet), recentBlockhash: blockhash,
    instructions: instructionsFor(new PublicKey(wallet), accounts) }).compileToV0Message());
}
function fits(transaction: VersionedTransaction) {
  try { return transaction.serialize().length <= SOLANA_TX_SIZE_LIMIT; } catch { return false; }
}
function decodeToken(info: AccountInfo<Buffer>, account: CompoundRecoveryAccount, wallet: string) {
  const program = new PublicKey(account.program);
  if (!info.owner.equals(program) || info.executable) throw new Error("Cleanup recipient program mismatch");
  const token = unpackAccount(new PublicKey(account.destination), info, program);
  if (!token.owner.equals(new PublicKey(wallet)) || token.mint.toBase58() !== account.mint || !token.isInitialized || token.isFrozen) {
    throw new Error("Cleanup recipient owner, mint or state mismatch");
  }
  return token;
}

type CleanupSimulationInput = {
  connection: Connection; transaction: VersionedTransaction; summary: CompoundRecoverySummary; sigVerify: boolean;
  /** Prepared message; wallet-raised ComputeBudget priority is allowed up to 0.01 SOL extra. */
  prepared?: VersionedTransaction;
};
class CleanupSnapshotChanged extends Error {}
export async function simulateAndVerifyCleanupBatch(input: CleanupSimulationInput) {
  try { return await simulateCleanupBatchSnapshot(input); }
  catch (error) {
    // Another independently signed chunk may have credited the same ATA or
    // returned rent after our snapshot. Repeat the complete validation once;
    // never relax the exact token/SOL budgets to accommodate a moving bank.
    if (!(error instanceof CleanupSnapshotChanged)) throw error;
    return simulateCleanupBatchSnapshot(input);
  }
}
async function simulateCleanupBatchSnapshot(input: CleanupSimulationInput) {
  const { connection, transaction, summary, sigVerify } = input;
  const { accounts, alreadyClosed } = await readBatchAccounts(connection, summary.wallet, summary.compoundAccounts);
  if (alreadyClosed.length || accounts.length !== summary.compoundAccounts.length || accounts.some((account, index) => {
    const approved = summary.compoundAccounts[index]!;
    return ["address", "amount", "destination", "sourceLamports", "rentLamports", "space", "decimals", "mint", "program", "seed"].some(field =>
      account[field as keyof CompoundRecoveryAccount] !== approved[field as keyof CompoundRecoveryAccount]);
  })) throw new Error("Cleanup source balance or identity changed; prepare again");
  const destinations = [...new Set(accounts.filter(account => account.amount !== "0").map(account => account.destination))];
  const snapshot = await connection.getMultipleAccountsInfoAndContext([...destinations, summary.wallet].map(address => new PublicKey(address)), "confirmed");
  const before = snapshot.value;
  if (before.length !== destinations.length + 1 || !before.at(-1)) throw new Error("Cleanup missing wallet readback");
  const addresses = [...accounts.map(account => account.address), ...destinations, summary.wallet];
  const result = await withContextSlotRetry(() => connection.simulateTransaction(transaction, { sigVerify, commitment: "confirmed", minContextSlot: snapshot.context.slot, accounts: { encoding: "base64", addresses } }));
  if (result.value.err) throw new Error("Cleanup transaction simulation failed");
  const after = result.value.accounts;
  if (!after || after.length !== addresses.length) throw new Error("Cleanup simulation missing account readback");
  for (let index = 0; index < accounts.length; index++) {
    const closed = after[index];
    if (closed !== null && (!closed || closed.lamports !== 0 || closed.data[0] !== "" || closed.executable || closed.owner !== SystemProgram.programId.toBase58())) {
      throw new Error("Cleanup simulation did not close source");
    }
  }
  let newRent = 0n;
  for (let index = 0; index < destinations.length; index++) {
    const descriptor = accounts.find(account => account.destination === destinations[index])!;
    const prior = before[index], simulated = after[accounts.length + index];
    const previous = prior ? decodeToken(prior, descriptor, summary.wallet).amount : 0n;
    if (!simulated?.data[0]) throw new Error("Cleanup simulation missing recipient");
    const decoded = decodeToken({ ...simulated, owner: new PublicKey(simulated.owner),
      data: Buffer.from(simulated.data[0], "base64"), rentEpoch: simulated.rentEpoch ?? 0 }, descriptor, summary.wallet);
    const expected = accounts.filter(account => account.destination === descriptor.destination).reduce((sum, account) => sum + BigInt(account.amount), 0n);
    if (decoded.amount - previous !== expected) {
      if (result.context.slot > snapshot.context.slot) throw new CleanupSnapshotChanged("Cleanup recipient balance changed between snapshot and simulation");
      throw new Error("Cleanup recipient balance mismatch");
    }
    // Native SOL backing follows the token transfer; it is not returned as rent.
    const backing = decoded.isNative ? expected : 0n;
    const rentDebit = BigInt(simulated.lamports) - BigInt(prior?.lamports ?? 0) - backing;
    if (rentDebit < 0n || prior && rentDebit !== 0n) throw new Error("Cleanup recipient rent mismatch");
    newRent += rentDebit;
  }
  const walletAfter = after.at(-1), walletBefore = before.at(-1)!;
  const returned = accounts.reduce((sum, account) => sum + BigInt(account.rentLamports), 0n);
  if (!walletBefore.owner.equals(SystemProgram.programId) || !walletAfter || walletAfter.owner !== SystemProgram.programId.toBase58()) {
    throw new Error("Cleanup wallet owner mismatch");
  }
  const expectedWallet = BigInt(walletBefore.lamports) + returned - newRent - BigInt(summary.feeLamports);
  const extraPriority = walletPriorityFeeAllowance(input.prepared, transaction);
  const actualWallet = BigInt(walletAfter.lamports);
  if (actualWallet > expectedWallet || actualWallet < expectedWallet - extraPriority) {
    if (result.context.slot > snapshot.context.slot) throw new CleanupSnapshotChanged("Cleanup wallet balance changed between snapshot and simulation");
    throw new Error("Cleanup wallet rent or fee mismatch");
  }
  return { unitsConsumed: result.value.unitsConsumed };
}

export async function buildCleanupBatch(connection: Connection, wallet: string, descriptors: unknown) {
  const { accounts, alreadyClosed } = await readBatchAccounts(connection, wallet, descriptors);
  if (!accounts.length) return { wallet, alreadyClosed, transactions: [] };
  const simulationBlockhash = await connection.getLatestBlockhash("confirmed");
  const groups: CompoundRecoveryAccount[][] = [];
  let current: CompoundRecoveryAccount[] = [];
  for (const account of accounts) {
    if (!fits(transactionFor(wallet, [...current, account], simulationBlockhash.blockhash))) {
      if (!current.length) throw new Error("Cleanup source exceeds transaction packet limit");
      groups.push(current); current = [];
    }
    current.push(account);
    if (!fits(transactionFor(wallet, current, simulationBlockhash.blockhash))) throw new Error("Cleanup source exceeds transaction packet limit");
  }
  if (current.length) groups.push(current);
  const transactions: { summary: CompoundRecoverySummary; transaction: VersionedTransaction }[] = [];
  for (const group of groups) {
    const transaction = transactionFor(wallet, group, simulationBlockhash.blockhash);
    const fee = await estimateFeeForMessage(connection, transaction.message, "confirmed", {
      emptyError: "Unable to estimate cleanup fee",
    });
    if (fee > 10_000_000) throw new Error("Unable to estimate cleanup fee");
    const summary: CompoundRecoverySummary = { operation: "recovery", simulated: true, wallet, compoundAccounts: group,
      feeLamports: fee, sizeBytes: transaction.serialize().length, ...stampPreparedBlockhash(simulationBlockhash) };
    const verified = await simulateAndVerifyCleanupBatch({ connection, transaction, summary, sigVerify: false });
    summary.unitsConsumed = verified.unitsConsumed;
    transactions.push({ transaction, summary });
  }
  // All transactions share the freshest blockhash so one wallet approval has a full validity window.
  const latest = await connection.getLatestBlockhash("confirmed");
  return { wallet, alreadyClosed, transactions: transactions.map(({ transaction, summary }) => ({
    summary: { ...summary, ...stampPreparedBlockhash(latest) }, transaction: restampVersionedTransaction(transaction, latest.blockhash),
  })) };
}

export function validCleanupSignature(transaction: VersionedTransaction, wallet: string) {
  return isSingleWalletSignedTransaction(transaction, wallet) && nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0]!, new PublicKey(wallet).toBytes());
}

/** A finalized signature and exact transaction-local token credits are required; current balances never establish success. */
export function confirmedCleanupBatch(transaction: ParsedTransactionWithMeta, wallet: string, summary: CompoundRecoverySummary) {
  if (!confirmedRecovery(transaction, wallet, summary) || !transaction.meta) return false;
  const records = (address: string) => {
    const index = transaction.transaction.message.accountKeys.findIndex(item => item.pubkey.toBase58() === address);
    return { before: transaction.meta!.preTokenBalances?.find(item => item.accountIndex === index),
      after: transaction.meta!.postTokenBalances?.find(item => item.accountIndex === index) };
  };
  for (const source of summary.compoundAccounts) {
    const record = records(source.address).before;
    if (record?.programId !== source.program || record.uiTokenAmount.decimals !== source.decimals) return false;
  }
  const destinations = [...new Set(summary.compoundAccounts.filter(account => account.amount !== "0").map(account => account.destination))];
  return destinations.every(destination => {
    const descriptor = summary.compoundAccounts.find(account => account.destination === destination)!;
    const { before, after } = records(destination);
    if (!after || after.owner !== wallet || after.mint !== descriptor.mint || after.programId !== descriptor.program ||
      before && (before.owner !== wallet || before.mint !== descriptor.mint || before.programId !== descriptor.program)) return false;
    const expected = summary.compoundAccounts.filter(account => account.destination === destination).reduce((sum, account) => sum + BigInt(account.amount), 0n);
    return BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0") === expected;
  });
}
