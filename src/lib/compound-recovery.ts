import "server-only";

import { PublicKey, TransactionMessage, VersionedTransaction, type Connection, type AccountInfo } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getTransferFeeConfig, getTransferHook, getPausableConfig,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import type { CompoundAccount } from "./compound-types";
import type { CompoundRecoveryAccount, CompoundRecoverySummary } from "./compound-recovery-types";
import { rpcConnection } from "./rpc";
import { restampVersionedTransaction, stampPreparedBlockhash } from "./fresh-blockhash";

function tokenBalance(info: AccountInfo<Buffer> | null, address: PublicKey, program: PublicKey, wallet: PublicKey, mint: PublicKey) {
  if (!info) return 0n;
  if (!info.owner.equals(program)) throw new Error("Yield account token program mismatch");
  const account = unpackAccount(address, info, program);
  if (!account.owner.equals(wallet) || !account.mint.equals(mint) || !account.isInitialized || account.isFrozen) {
    throw new Error("Yield account owner, mint, or availability status mismatch");
  }
  return account.amount;
}

export async function readRecoveryAccounts(connection: Connection, walletAddress: string, values: unknown) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 2) throw new Error("Maximum two yield accounts may be recovered per attempt");
  const wallet = new PublicKey(walletAddress);
  const accounts: CompoundRecoveryAccount[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object") throw new Error("Invalid yield account data");
    const descriptor = value as CompoundAccount;
    if (typeof descriptor.seed !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(descriptor.seed) ||
      typeof descriptor.address !== "string" || typeof descriptor.mint !== "string" ||
      ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(descriptor.program)) {
      throw new Error("Invalid yield account seed or program");
    }
    const program = new PublicKey(descriptor.program);
    const address = new PublicKey(descriptor.address);
    const mint = new PublicKey(descriptor.mint);
    const derived = await PublicKey.createWithSeed(wallet, descriptor.seed, program);
    if (!derived.equals(address) || seen.has(descriptor.address)) throw new Error("Yield account derived address mismatch or duplicate");
    seen.add(descriptor.address);
    const [accountInfo, mintInfo] = await connection.getMultipleAccountsInfo([address, mint], "confirmed");
    if (!accountInfo) continue; // A failed atomic compound creates no accounts.
    if (!mintInfo || !mintInfo.owner.equals(program)) throw new Error("Yield mint program mismatch");
    const mintData = unpackMint(mint, mintInfo, program);
    const fee = getTransferFeeConfig(mintData);
    const hook = getTransferHook(mintData);
    if (fee && (fee.newerTransferFee.transferFeeBasisPoints || fee.olderTransferFee.transferFeeBasisPoints) ||
      hook?.programId && !hook.programId.equals(PublicKey.default) || getPausableConfig(mintData)?.paused) {
      throw new Error("Yield asset has transfer fee, hook, or is paused; cannot be directly recovered");
    }
    const amount = tokenBalance(accountInfo, address, program, wallet, mint);
    const decoded = unpackAccount(address, accountInfo, program);
    if (decoded.closeAuthority && !decoded.closeAuthority.equals(wallet)) throw new Error("Yield account close authority has changed");
    // WSOL transfer also moves its backing lamports into the destination ATA;
    // only the remaining rent/donations return to the wallet on close.
    const refundableLamports = decoded.isNative ? BigInt(accountInfo.lamports) - amount : BigInt(accountInfo.lamports);
    accounts.push({ ...descriptor, space: accountInfo.data.length, rentLamports: Number(refundableLamports),
      sourceLamports: accountInfo.lamports, amount: amount.toString(), decimals: mintData.decimals,
      destination: getAssociatedTokenAddressSync(mint, wallet, false, program).toBase58() });
  }
  if (!accounts.length) throw new Error("No recoverable yield accounts; please verify original compound transaction status first");
  return accounts;
}

export async function simulateAndVerifyRecovery(input: {
  connection: Connection; transaction: VersionedTransaction; summary: CompoundRecoverySummary; sigVerify: boolean;
}) {
  const { connection, transaction, summary, sigVerify } = input;
  const wallet = new PublicKey(summary.wallet);
  const accounts = await readRecoveryAccounts(connection, summary.wallet, summary.compoundAccounts);
  if (accounts.length !== summary.compoundAccounts.length || accounts.some((account, index) => {
    const approved = summary.compoundAccounts[index];
    return !approved || account.address !== approved.address || account.amount !== approved.amount ||
      account.destination !== approved.destination || account.sourceLamports !== approved.sourceLamports;
  })) throw new Error("Yield account balance or identity has changed, please reprepare recovery");
  const destinations = [...new Set(accounts.filter((account) => account.amount !== "0").map((account) => account.destination))];
  const before = await connection.getMultipleAccountsInfo(destinations.map((key) => new PublicKey(key)), "confirmed");
  const addresses = [...accounts.map((account) => account.address), ...destinations, summary.wallet];
  const result = await connection.simulateTransaction(transaction, {
    sigVerify, commitment: "confirmed", accounts: { encoding: "base64", addresses },
  });
  if (result.value.err) throw new Error("Remaining yield recovery simulation failed");
  const after = result.value.accounts;
  if (!after || after.length !== addresses.length) throw new Error("Recovery simulation missing account readback");
  for (let index = 0; index < accounts.length; index++) {
    if (after[index] !== null) throw new Error("Simulation did not close yield account");
  }
  for (let index = 0; index < destinations.length; index++) {
    const account = accounts.find((item) => item.destination === destinations[index])!;
    const key = new PublicKey(account.destination);
    const program = new PublicKey(account.program);
    const mint = new PublicKey(account.mint);
    const prior = tokenBalance(before[index] ?? null, key, program, wallet, mint);
    const simulated = after[accounts.length + index];
    if (!simulated?.data[0]) throw new Error("Recovery simulation missing recipient ATA");
    const received = tokenBalance({ ...simulated, data: Buffer.from(simulated.data[0], "base64"),
      owner: new PublicKey(simulated.owner), rentEpoch: simulated.rentEpoch ?? 0 }, key, program, wallet, mint);
    const expected = accounts.filter((item) => item.destination === account.destination)
      .reduce((sum, item) => sum + BigInt(item.amount), 0n);
    if (received - prior !== expected) throw new Error("Recovery amount or recipient mismatch");
  }
  const solBefore = await connection.getBalance(wallet, "confirmed");
  const solAfter = after[addresses.length - 1];
  if (!solAfter) throw new Error("Recovery simulation missing wallet SOL");
  const returned = accounts.reduce((sum, account) => sum + BigInt(account.rentLamports), 0n);
  if (BigInt(solAfter.lamports) > BigInt(solBefore) + returned ||
    BigInt(solAfter.lamports) < BigInt(solBefore) + returned - 10_000_000n) {
    throw new Error("Recovery SOL rent or fee mismatch");
  }
  return { unitsConsumed: result.value.unitsConsumed };
}

export async function buildAndSimulateCompoundRecovery(walletAddress: string, descriptors: unknown) {
  const connection = rpcConnection();
  const wallet = new PublicKey(walletAddress);
  const accounts = await readRecoveryAccounts(connection, walletAddress, descriptors);
  const instructions = accounts.flatMap((account) => {
    const mint = new PublicKey(account.mint), program = new PublicKey(account.program);
    const source = new PublicKey(account.address), destination = new PublicKey(account.destination);
    return [...(BigInt(account.amount) > 0n ? [
      createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, mint, program),
      createTransferCheckedInstruction(source, mint, destination, wallet, BigInt(account.amount), account.decimals, [], program)] : []),
      createCloseAccountInstruction(source, wallet, wallet, [], program)];
  });
  const simulation = await connection.getLatestBlockhash("confirmed");
  const simulated = new VersionedTransaction(new TransactionMessage({ payerKey: wallet,
    recentBlockhash: simulation.blockhash, instructions }).compileToV0Message());
  let sizeBytes: number;
  try { sizeBytes = simulated.serialize().length; } catch { throw new Error("Recovery transaction exceeds size limit"); }
  if (sizeBytes > 1_232) throw new Error("Recovery transaction exceeds size limit");
  const fee = await connection.getFeeForMessage(simulated.message, "confirmed");
  if (fee.value === null) throw new Error("Unable to estimate recovery transaction fee");
  const summary: CompoundRecoverySummary = { operation: "recovery", simulated: true, wallet: walletAddress,
    compoundAccounts: accounts, feeLamports: fee.value, sizeBytes, ...stampPreparedBlockhash(simulation) };
  const verified = await simulateAndVerifyRecovery({ connection, transaction: simulated, summary, sigVerify: false });
  const latest = await connection.getLatestBlockhash("confirmed");
  Object.assign(summary, stampPreparedBlockhash(latest));
  summary.unitsConsumed = verified.unitsConsumed;
  return { transaction: restampVersionedTransaction(simulated, latest.blockhash), summary };
}
