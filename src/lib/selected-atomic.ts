import { swapRouteInstructions, rejectUnselectedWalletTokenWrites, readSwapFeeConfig, collectSwapFee, fitFeeCollections, type FeeCollection } from "./swap";
import "server-only";

import { createHash } from "node:crypto";
import { buildSelectedAddInstruction } from "./selected-add-instruction";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_SOL_MINT, QUOTE_TTL_MS } from "./ids";
import { readLookupTables, validateRouteTables } from "./transaction-helpers";
import { rpcConnection } from "./rpc";
import { beamTipInstruction, chooseBeamTransaction, fetchBeamTipAddress } from "./solami-beam";
import { isTxOversizeError, type JupiterRouteConstraints } from "./jupiter-route-retry";
import type { BuildRoute } from "./swap/jupiter";
import type { JupiterRetryBudget } from "./jupiter/client";
import { getSelectedQuoteBundle } from "./selected-quote";
import { simulateAndVerifySelectedTransaction } from "./selected-simulation";
import { readSelectedPositionState, type PositionSelection, type SelectedPositionState } from "./selected-state";

export async function buildAndSimulateSelectedZap(
  walletAddress: string, selection: PositionSelection, amount: string, floorBps: number,
  toleranceBps?: number, options?: { enforceResaleFloor?: boolean; signal?: AbortSignal; budget?: JupiterRetryBudget },
) {
  const connection = rpcConnection(undefined, { signal: options?.signal });
  const state = await readSelectedPositionState(walletAddress, selection, connection, false, { displayPrices: false });
  const attempts: JupiterRouteConstraints[] = [{ maxAccounts: 24 }, { maxAccounts: 20, onlyDirectRoutes: true }];
  for (const [index, jupiter] of attempts.entries()) {
    options?.signal?.throwIfAborted();
    try {
      return await buildAndSimulateSelectedZapOnce(walletAddress, selection, amount, floorBps, toleranceBps,
        jupiter, options?.enforceResaleFloor !== false, connection, state, options?.signal, options?.budget);
    } catch (error) {
      if (index === attempts.length - 1 || !isTxOversizeError(error)) throw error;
    }
  }
  throw new Error("No compact add-liquidity route available");
}

async function buildAndSimulateSelectedZapOnce(
  walletAddress: string, selection: PositionSelection, amount: string, floorBps: number,
  toleranceBps: number | undefined,
  jupiter: JupiterRouteConstraints, enforceResaleFloor: boolean, connection: Connection, state: SelectedPositionState, signal?: AbortSignal,
  budget?: JupiterRetryBudget,
) {
  const wallet = new PublicKey(walletAddress);
  const { quote, legs } = await getSelectedQuoteBundle(walletAddress, selection, amount, floorBps, toleranceBps, jupiter,
    { state, connection, signal, budget, buildTransactions: true, includeResale: enforceResaleFloor });
  if (enforceResaleFloor && !quote.passesFloor) throw new Error(quote.warning || "Conservative immediate resale ratio below selected threshold");
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired, please resimulate");
  const routes = legs.flatMap((item) => {
    if (!item.route) return [];
    if (!("swapInstruction" in item.route)) throw new Error("Swap route lacks transaction instructions");
    return [item.route as BuildRoute];
  });
  if (legs.length !== (state.rangeSide === "inside" ? 2 : 1) || legs.some((item) =>
    item.inputMint !== state.inputMint || ![state.mintA, state.mintB].includes(item.outputMint) ||
    item.route && (item.route.inputMint !== state.inputMint || item.route.outputMint !== item.outputMint ||
      BigInt(item.route.inAmount) !== item.spend - (item.feeAmount ?? 0n)))) throw new Error("Swap route does not match selected assets or position");
  const feeConfig = readSwapFeeConfig();
  const protocolFee = legs.reduce((sum, item) => sum + (item.feeAmount ?? 0n), 0n);
  if ((quote.feeAmount ?? "0") !== protocolFee.toString() || (quote.feeBps ?? 0) !== feeConfig.bps ||
    (quote.feeWallet ?? null) !== (feeConfig.wallet?.toBase58() ?? null))
    throw new Error("Quote protocol fee does not match configuration");
  const feeInstructions = feeConfig.wallet && protocolFee > 0n
    ? await collectSwapFee(connection, state.inputKind === "native"
      ? { payer: wallet, owner: wallet, recipient: feeConfig.wallet, amount: protocolFee, kind: "native" }
      : { payer: wallet, owner: wallet, recipient: feeConfig.wallet, amount: protocolFee, kind: "token",
        mint: new PublicKey(state.inputMint), source: new PublicKey(state.inputAccount!),
        decimals: state.inputDecimals, program: new PublicKey(state.inputTokenProgram!) }) : { instructions: [], routes: [] };
  const raydiumInstructions = [buildSelectedAddInstruction(state, quote, wallet)];
  const addInstructions = raydiumInstructions.filter((ix) => ix.programId.toBase58() === state.programId);
  const addDiscriminator = createHash("sha256").update("global:increase_liquidity_v2").digest().subarray(0, 8);
  const add = addInstructions[0];
  if (addInstructions.length !== 1 || !add || !add.data.subarray(0, 8).equals(addDiscriminator) ||
    add.keys[0]?.pubkey.toBase58() !== walletAddress || add.keys[2]?.pubkey.toBase58() !== state.poolId ||
    add.keys[4]?.pubkey.toBase58() !== state.positionAccount) {
    throw new Error("Raydium instruction is not increase_liquidity_v2 on selected position");
  }
  const routeInstructions = swapRouteInstructions(routes, wallet);
  await rejectUnselectedWalletTokenWrites(connection, wallet, [...feeInstructions.instructions, ...routeInstructions],
    [state.inputAccount, state.ataA, state.ataB, ...((feeInstructions as FeeCollection).receiveOnlyAccounts ?? [])].filter((item): item is string => Boolean(item)));
  const routeKeys = [...routes, ...feeInstructions.routes].flatMap((route) => Object.keys(route.addressesByLookupTableAddress || {}).map((key) => new PublicKey(key)));
  const [routeTables, raydiumTable] = await Promise.all([
    readLookupTables(connection, routeKeys),
    connection.getAddressLookupTable(new PublicKey("AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU"), { commitment: "confirmed" }),
  ]);
  const raydiumTables = raydiumTable.value?.isActive() ? [raydiumTable.value] : [];
  validateRouteTables([...routes, ...feeInstructions.routes], routeTables);
  const directSol = state.inputKind === "native" ? legs.find((item) => !item.route && item.outputMint === NATIVE_SOL_MINT) : null;
  const wrapInstructions = directSol ? [
    createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB),
      wallet, new PublicKey(NATIVE_SOL_MINT), TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: wallet,
      toPubkey: new PublicKey(state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB), lamports: directSol.spend }),
    createSyncNativeInstruction(new PublicKey(state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB)),
  ] : [];
  // The direct SOL wrap above already creates its ATA idempotently.
  const wrappedAta = directSol ? (state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB) : null;
  const createAtaInstructions = [
    ...(state.ataAExists || wrappedAta === state.ataA ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataA), wallet,
      new PublicKey(state.mintA), new PublicKey(state.programA))]),
    ...(state.ataBExists || wrappedAta === state.ataB ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataB), wallet,
      new PublicKey(state.mintB), new PublicKey(state.programB))]),
  ];
  const tables = [...new Map([...routeTables, ...raydiumTables]
    .map((table) => [table.key.toBase58(), table])).values()];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  let baseInstructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...feeInstructions.instructions, ...routeInstructions, ...wrapInstructions, ...createAtaInstructions, ...raydiumInstructions];
  const compile = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({
    payerKey: wallet, recentBlockhash: blockhash, instructions,
  }).compileToV0Message(tables));
  if (!feeInstructions.routes.length) {
    try { if (compile(baseInstructions).serialize().length > 1232) throw new RangeError(); }
    catch { throw new Error("Complete swap + add transaction exceeds 1,232 byte limit, please select simpler route or other asset"); }
  }
  const tip = await fetchBeamTipAddress({ signal });
  signal?.throwIfAborted();
  const feeFit = await fitFeeCollections(connection, [feeInstructions], baseInstructions, compile,
    tip ? beamTipInstruction(wallet, tip.address, tip.lamports) : undefined);
  baseInstructions = feeFit.instructions;
  const withoutTip = compile(baseInstructions);
  try {
    if (withoutTip.serialize().length > 1_232) throw new RangeError("encoding overruns Uint8Array");
  } catch (error) {
    if (error instanceof RangeError || error instanceof Error && error.message.includes("encoding overruns Uint8Array")) {
      throw new Error("Complete swap + add transaction exceeds 1,232 byte limit, please select simpler route or other asset");
    }
    throw error;
  }
  const withTip = tip ? compile([...baseInstructions, beamTipInstruction(wallet, tip.address, tip.lamports)]) : null;
  const chosen = chooseBeamTransaction(withoutTip, withTip);
  const transaction = chosen.transaction;
  // web3.js allocates a 1,232-byte buffer while serializing a v0 message.
  // Oversized messages throw before a later size comparison can run.
  let sizeBytes: number;
  try {
    sizeBytes = transaction.serialize().length;
  } catch (error) {
    if (error instanceof RangeError ||
      error instanceof Error && error.message.includes("encoding overruns Uint8Array")) {
      throw new Error("Complete swap + add transaction exceeds 1,232 byte limit, please select simpler route or other asset");
    }
    throw error;
  }
  if (sizeBytes > 1_232) throw new Error(`Complete swap + add transaction ${sizeBytes} bytes, exceeds 1,232 byte limit`);
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired while constructing transaction, please resimulate");
  const [verified, fee] = await Promise.all([simulateAndVerifySelectedTransaction({
    connection, transaction, wallet, state, requested: BigInt(quote.requested),
    expectedLiquidity: BigInt(quote.liquidity), sigVerify: false, useStateSnapshot: true,
  }), connection.getFeeForMessage(transaction.message, "confirmed")]);
  if (fee.value === null) throw new Error("Unable to estimate complete transaction network fee");
  const timestamp = Date.now();
  const summary = {
    simulated: true, quote, sizeBytes, unitsConsumed: verified.unitsConsumed,
    feeLamports: fee.value, lastValidBlockHeight, blockhash,
    positionMint: state.positionMint, positionAccount: state.positionAccount, poolId: state.poolId,
    inputMint: state.inputMint, inputKind: state.inputKind, startingLiquidity: state.liquidity,
    startingBalances: state.balances, simulatedEndingLiquidity: verified.endingLiquidity,
    simulatedInputSpent: verified.spentInput, simulatedDustA: verified.dustA,
    simulatedDustB: verified.dustB, simulatedSolDebitLamports: verified.solDebitLamports,
    simulatedAt: timestamp, expiresAt: timestamp + QUOTE_TTL_MS,
    beam: {
      included: chosen.included,
      tipLamports: chosen.included && tip ? tip.lamports : 0,
      tipAddress: chosen.included && tip ? tip.address.toBase58() : null,
      skippedReason: chosen.included ? null : chosen.skippedReason,
    },
  };
  return { summary, transaction };
}
