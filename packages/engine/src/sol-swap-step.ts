// Two-transaction native SOL open, step 1/2: a pure SOL -> pool-token Jupiter
// swap. Wallets (Phantom) block SOL-input opens that combine wrap + swap +
// Raydium open, but pass a plain wrap / swap / close and a token-input open.
// The 10 bps protocol fee is Jupiter's input-mint platform fee inside this
// swap (into the fee wallet's pre-created wSOL ATA); there is no direct
// transfer to the fee wallet and no Raydium instruction here. Step 2/2 is a
// normal token-input open sized from what this swap actually delivered.
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID, unpackAccount,
} from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { parseTokenAmount } from "./amount";
import { NATIVE_SOL_MINT } from "./ids";
import { stampPreparedBlockhash, restampVersionedTransaction } from "./fresh-blockhash";
import { validateRouteTables } from "./transaction-helpers";
import { assertOpenTransactionSize, compactAtaInstructions, compileCompactOpenTransaction, openLookupTableReader } from "./open-transaction";
import { defaultRpcConnection, rpcConnection } from "./rpc";
import { estimateFeeForMessage, OPEN_FEE_ESTIMATE_MESSAGE } from "./rpc/fee-estimate";
import { JupiterNoRouteError, type BuildRoute } from "./swap/jupiter";
import { feeSwapLeg } from "./swap/leg";
import { readSwapFeeConfig, swapFeeRecipientAta } from "./swap/fee";
import { wrapNativeSolInstructions } from "./swap/collection";
import { rejectUnselectedWalletTokenWrites, swapRouteInstructions } from "./swap/instructions";
import { readOpenPoolState } from "./open-state";
import { JUPITER_MAX_ACCOUNTS } from "./jupiter-route-retry";
import { atomicComputeUnitLimitInstruction, measuredComputeUnitLimit } from "./transaction-limits";

export const SOL_POOL_INPUT_MESSAGE = "SOL input is not available for pools that contain SOL yet. Please use another token.";

export type SolSwapStepSummary = {
  operation: "sol-swap-step";
  wallet: string;
  poolId: string;
  inputMint: typeof NATIVE_SOL_MINT;
  /** Pool token the swap delivers; step 2/2 opens with it as a token input. */
  outputMint: string;
  outputDecimals: number;
  outputSymbol: string | null;
  outputAccount: string;
  /** Gross lamports wrapped and swapped (fee included, charged by Jupiter). */
  requested: string;
  feeBps: number;
  feeAmount: string;
  feeWallet: string | null;
  quotedOut: string;
  minOut: string;
  /** Output-account increase in the server-side simulation. */
  simulatedOut: string;
  simulatedSolDebitLamports: string;
  feeLamports: number;
  sizeBytes: number;
  unitsConsumed: number;
  blockhash: string;
  lastValidBlockHeight: number;
  simulatedAt: number;
  expiresAt: number;
};

async function buildForOutput(connection: Connection, walletAddress: string, state: Awaited<ReturnType<typeof readOpenPoolState>>,
  outputMint: string, requested: bigint) {
  const wallet = new PublicKey(walletAddress);
  const feeConfig = readSwapFeeConfig();
  const isA = outputMint === state.mintA;
  const outputAccount = new PublicKey(isA ? state.ataA : state.ataB);
  const outputProgram = new PublicKey(isA ? state.programA : state.programB);
  const leg = await feeSwapLeg({
    wallet: walletAddress, inputMint: NATIVE_SOL_MINT, outputMint, spend: requested, feeBps: feeConfig.bps,
    native: false, inputFee: true, build: true, constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.wide },
    ownPool: state,
  });
  if (!leg.route || !("swapInstruction" in leg.route)) throw new Error("SOL swap route is missing");
  const route = leg.route as BuildRoute;
  if (feeConfig.bps > 0 && (!leg.feeInRoute || leg.feeAmount <= 0n)) {
    throw new Error("Native SOL protocol fee must be collected inside the Jupiter swap");
  }
  const nativeAta = getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID);
  const routeInstructions = swapRouteInstructions([route], wallet);
  await rejectUnselectedWalletTokenWrites(connection, wallet, routeInstructions, [nativeAta.toBase58(), outputAccount.toBase58()]);
  const readTables = openLookupTableReader(connection);
  const tables = await readTables(Object.keys(route.addressesByLookupTableAddress || {}).map((key) => new PublicKey(key)));
  validateRouteTables([route], tables);
  // Same shape as the Phantom-clean diag v4: CU limit, wrap, (output ATA), swap, close. No Beam tip.
  const instructions = await compactAtaInstructions(connection, [
    atomicComputeUnitLimitInstruction(),
    ...wrapNativeSolInstructions(wallet, requested),
    createAssociatedTokenAccountIdempotentInstruction(wallet, outputAccount, wallet, new PublicKey(outputMint), outputProgram),
    ...routeInstructions,
    createCloseAccountInstruction(nativeAta, wallet, wallet),
  ]);
  const feeAta = feeConfig.wallet ? swapFeeRecipientAta(feeConfig.wallet, new PublicKey(NATIVE_SOL_MINT), TOKEN_PROGRAM_ID).toBase58() : null;
  if (instructions.some((ix) => ix.keys.some((key) => feeConfig.wallet && key.pubkey.equals(feeConfig.wallet)))) {
    throw new Error("SOL swap step must not reference the fee wallet directly");
  }
  const simulationBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const compiled = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: simulationBlockhash, instructions }, tables);
  const transaction = compiled.transaction;
  assertOpenTransactionSize(transaction);
  if (transaction.message.header.numRequiredSignatures !== 1) throw new Error("SOL swap step must require only the wallet signature");
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [walletAddress, outputAccount.toBase58()] },
  });
  if (simulation.value.err) throw new Error(`SOL swap simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const [walletAfter, outputAfter] = simulation.value.accounts ?? [];
  if (!walletAfter || !outputAfter) throw new Error("SOL swap simulation did not return account state");
  const outputPost = unpackAccount(outputAccount, {
    data: Buffer.from(outputAfter.data[0] ?? "", "base64"), owner: new PublicKey(outputAfter.owner),
    lamports: outputAfter.lamports, executable: outputAfter.executable,
  }, outputProgram);
  if (!outputPost.owner.equals(wallet) || outputPost.mint.toBase58() !== outputMint) throw new Error("SOL swap output account mismatch");
  const outputPre = BigInt(isA ? state.balances.a : state.balances.b);
  const simulatedOut = outputPost.amount - outputPre;
  if (simulatedOut < leg.minOut) throw new Error("SOL swap simulation delivered less than the minimum output");
  const solDebit = BigInt(state.solLamports) - BigInt(walletAfter.lamports);
  // Wrapped amount + at most one new token account + network fee headroom.
  if (solDebit > requested + 5_000_000n) throw new Error("SOL swap simulation debits more SOL than expected");
  if (feeAta && feeConfig.bps > 0 && !route.swapInstruction.accounts.some((key) => key.pubkey === feeAta && key.isWritable)) {
    throw new Error("Jupiter swap does not pay the protocol fee account");
  }
  const unitsConsumed = simulation.value.unitsConsumed ?? 0;
  // Simulated with the 1.4M ceiling; ship the measured limit so a wallet-added priority fee stays small.
  const limitIndex = instructions.findIndex((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2);
  if (limitIndex < 0) throw new Error("SOL swap step is missing its compute-unit limit");
  const sized = instructions.map((ix, index) => index === limitIndex
    ? ComputeBudgetProgram.setComputeUnitLimit({ units: measuredComputeUnitLimit(unitsConsumed) }) : ix);
  const final = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: simulationBlockhash, instructions: sized }, tables).transaction;
  assertOpenTransactionSize(final);
  return { leg, transaction: final, tables, outputAccount, simulatedOut, solDebit, unitsConsumed, feeConfig };
}

export async function buildAndSimulateSolSwapStep(walletAddress: string, poolId: string, amount: string,
  options?: { connection?: Connection }): Promise<{ summary: SolSwapStepSummary; transaction: VersionedTransaction }> {
  const connection = options?.connection ?? rpcConnection();
  const state = await readOpenPoolState(walletAddress, { poolId, inputMint: NATIVE_SOL_MINT, inputKind: "native" }, connection);
  if ([state.mintA, state.mintB].includes(NATIVE_SOL_MINT)) throw new Error(SOL_POOL_INPUT_MESSAGE);
  if (state.paused || state.frozen || state.transferFee || state.unsupportedExtensions.length) {
    throw new Error("This pool cannot accept deposits right now");
  }
  const requested = parseTokenAmount(amount, 9);
  if (requested <= 0n) throw new Error("Input amount too small to obtain route");
  if (BigInt(state.inputBalance) < requested) throw new Error("Insufficient input asset balance or SOL reserve");
  let built: Awaited<ReturnType<typeof buildForOutput>> | undefined;
  let lastNoRoute: unknown;
  for (const outputMint of [state.mintA, state.mintB]) {
    try {
      built = await buildForOutput(connection, walletAddress, state, outputMint, requested);
      break;
    } catch (error) {
      if (!(error instanceof JupiterNoRouteError)) throw error;
      lastNoRoute = error;
    }
  }
  if (!built) throw lastNoRoute ?? new JupiterNoRouteError();
  const latest = await connection.getLatestBlockhash("confirmed");
  const restamped = restampVersionedTransaction(built.transaction, latest.blockhash, built.tables);
  const sizeBytes = assertOpenTransactionSize(restamped);
  const feeLamports = await estimateFeeForMessage(connection, restamped.message, "confirmed", {
    fallback: defaultRpcConnection, emptyError: OPEN_FEE_ESTIMATE_MESSAGE,
  });
  const outputMint = built.leg.outputMint;
  const isA = outputMint === state.mintA;
  const summary: SolSwapStepSummary = {
    operation: "sol-swap-step", wallet: walletAddress, poolId: state.poolId, inputMint: NATIVE_SOL_MINT,
    outputMint, outputDecimals: isA ? state.decimalsA : state.decimalsB, outputSymbol: isA ? state.symbolA : state.symbolB,
    outputAccount: built.outputAccount.toBase58(),
    requested: requested.toString(), feeBps: built.feeConfig.bps, feeAmount: built.leg.feeAmount.toString(),
    feeWallet: built.feeConfig.wallet?.toBase58() ?? null,
    quotedOut: built.leg.route!.outAmount, minOut: built.leg.minOut.toString(),
    simulatedOut: built.simulatedOut.toString(), simulatedSolDebitLamports: built.solDebit.toString(),
    feeLamports, sizeBytes, unitsConsumed: built.unitsConsumed,
    ...stampPreparedBlockhash(latest),
  };
  return { summary, transaction: restamped };
}

export type SolSwapDelivery =
  | { status: "pending" | "expired" | "failed" }
  | { status: "confirmed"; delivered: string; decimals: number; blockTime: number | null; feeAccountPaid: boolean; slot: number };

/**
 * What a confirmed step-1 swap ACTUALLY delivered to the wallet: the wallet's
 * post- minus pre-transaction balance of `outputMint` from the transaction
 * meta (never the quote). Also a cheap sanity check that the wallet paid it
 * and that the protocol fee account was written. Not anti-tampering.
 */
export async function readSolSwapDelivery(input: {
  signature: string; wallet: string; outputMint: string; lastValidBlockHeight?: number; connection?: Connection;
}): Promise<SolSwapDelivery> {
  const connection = input.connection ?? rpcConnection();
  const status = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
  if (!status) {
    if (input.lastValidBlockHeight && await connection.getBlockHeight("confirmed") > input.lastValidBlockHeight) return { status: "expired" };
    return { status: "pending" };
  }
  if (status.err) return { status: "failed" };
  if (status.confirmationStatus === "processed") return { status: "pending" };
  const tx = await connection.getTransaction(input.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) return { status: "pending" };
  if (tx.meta.err) return { status: "failed" };
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  if (keys.get(0)?.toBase58() !== input.wallet) throw new Error("Swap transaction was not paid by this wallet");
  const sum = (balances: typeof tx.meta.preTokenBalances) => (balances ?? [])
    .filter((item) => item.owner === input.wallet && item.mint === input.outputMint)
    .reduce((total, item) => total + BigInt(item.uiTokenAmount.amount), 0n);
  const post = tx.meta.postTokenBalances?.find((item) => item.owner === input.wallet && item.mint === input.outputMint);
  if (!post) throw new Error("Swap transaction did not deliver the expected pool token");
  const delivered = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  if (delivered <= 0n) throw new Error("Swap transaction did not deliver the expected pool token");
  const feeWallet = readSwapFeeConfig().wallet;
  const feeAta = feeWallet ? swapFeeRecipientAta(feeWallet, new PublicKey(NATIVE_SOL_MINT), TOKEN_PROGRAM_ID).toBase58() : null;
  const feeAccountPaid = !feeAta || [...Array(keys.length).keys()].some((index) => keys.get(index)?.toBase58() === feeAta);
  return { status: "confirmed", delivered: delivered.toString(), decimals: post.uiTokenAmount.decimals, blockTime: tx.blockTime ?? null, feeAccountPaid, slot: tx.slot };
}
