import "server-only";

import { createHash } from "node:crypto";
import BN from "bn.js";
import { ClmmInstrument, Raydium } from "@raydium-io/raydium-sdk-v2";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type Connection, type TransactionInstruction,
} from "@solana/web3.js";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import { restampVersionedTransaction, stampPreparedBlockhash } from "./fresh-blockhash";
import { instruction, readLookupTables, validateRouteTables } from "./transaction-helpers";
import { rpcConnection } from "./rpc";
import { BEAM_MIN_TIP_LAMPORTS, beamTipInstruction, chooseBeamTransaction, fetchBeamTipAddress } from "./solami-beam";
import { withJupiterRouteRetries, type JupiterRouteConstraints } from "./jupiter-route-retry";
import { getOpenPositionQuoteBundle } from "./open-quote";
import { simulateAndVerifyOpenTransaction } from "./open-simulation";
import type { OpenRangeInput } from "./open-range";
import type { OpenPositionSelection } from "./open-state";
import type { OpenPositionSummary } from "./open-types";

async function rejectUnselectedWalletTokenWrites(
  connection: Connection, wallet: PublicKey, instructions: TransactionInstruction[],
  allowedAccounts: string[],
) {
  const [legacy, token2022] = await Promise.all([
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
  ]);
  const writable = new Set(instructions.flatMap((ix) => ix.keys.filter((key) => key.isWritable)
    .map((key) => key.pubkey.toBase58())));
  const allowed = new Set(allowedAccounts);
  for (const { pubkey, account } of [...legacy.value, ...token2022.value]) {
    if (!writable.has(pubkey.toBase58()) || allowed.has(pubkey.toBase58())) continue;
    const decoded = unpackAccount(pubkey, account, account.owner);
    if (decoded.amount > 0n) throw new Error("Jupiter route may modify unselected wallet assets, transaction stopped");
  }
}

function transactionSize(transaction: VersionedTransaction) {
  let size: number;
  try {
    size = transaction.serialize().length;
  } catch (error) {
    if (error instanceof RangeError ||
      error instanceof Error && error.message.includes("encoding overruns Uint8Array")) {
      throw new Error("Complete swap + open-position transaction exceeds 1,232 byte limit, please select simpler route or other asset");
    }
    throw error;
  }
  if (size > 1_232) {
    throw new Error(`Complete swap + open-position transaction ${size} bytes, exceeds 1,232 byte limit`);
  }
  return size;
}

export async function buildAndSimulateOpenPosition(
  walletAddress: string,
  selection: OpenPositionSelection,
  amount: string,
  range: OpenRangeInput,
  floorBps: number,
  toleranceBps?: number,
) {
  return withJupiterRouteRetries((jupiter) =>
    buildAndSimulateOpenPositionOnce(walletAddress, selection, amount, range, floorBps, toleranceBps, jupiter));
}

async function buildAndSimulateOpenPositionOnce(
  walletAddress: string,
  selection: OpenPositionSelection,
  amount: string,
  range: OpenRangeInput,
  floorBps: number,
  toleranceBps: number | undefined,
  jupiter: JupiterRouteConstraints,
) {
  const connection = rpcConnection();
  const wallet = new PublicKey(walletAddress);
  const { quote, legs, state } = await getOpenPositionQuoteBundle(
    walletAddress, selection, amount, range, floorBps, toleranceBps, jupiter,
  );
  if (!quote.passesFloor) throw new Error(quote.warning || "Conservative immediate resale ratio below selected threshold");
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired, please resimulate");
  const routes = legs.flatMap((item) => item.route ? [item.route] : []);
  if (legs.length !== (quote.rangeSide === "inside" ? 2 : 1) || legs.some((item) =>
    item.inputMint !== state.inputMint || ![state.mintA, state.mintB].includes(item.outputMint) ||
    item.route && (item.route.inputMint !== state.inputMint || item.route.outputMint !== item.outputMint ||
      BigInt(item.route.inAmount) !== item.spend))) {
    throw new Error("Swap route does not match selected assets or pool");
  }
  const raydium = await Raydium.load({ connection, owner: wallet, disableLoadToken: true });
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(state.poolId);
  if (poolInfo.programId !== state.programId || poolInfo.mintA.address !== state.mintA ||
    poolInfo.mintB.address !== state.mintB || poolInfo.config.tickSpacing !== state.tickSpacing) {
    throw new Error("Raydium pool program, mint, or tick spacing mismatch");
  }
  // Token-2022 NFT (no Metaplex metadata ix) keeps the v0 message smaller so a
  // Jupiter swap + open can still fit in 1,232 bytes. The SDK generates the
  // NFT mint Keypair as an extra signer; we partial-sign after restamping and
  // drop the secret without persisting or logging it.
  const built = await ClmmInstrument.openPositionFromLiquidityInstructions({
    poolInfo, poolKeys,
    ownerInfo: { wallet, tokenAccountA: new PublicKey(state.ataA), tokenAccountB: new PublicKey(state.ataB) },
    tickLower: quote.tickLower, tickUpper: quote.tickUpper,
    liquidity: new BN(quote.liquidity),
    amountMaxA: new BN(quote.amountMaxA), amountMaxB: new BN(quote.amountMaxB),
    base: null, withMetadata: "no-create", nft2022: true,
  });
  if (built.signers.length !== 1 || !built.signers[0]) {
    throw new Error("Raydium open-position must return exactly one extra signer (the position NFT mint)");
  }
  const nftMint = built.signers[0].publicKey;
  const nftMintAddress = nftMint.toBase58();
  const [apiPoolKeys] = await raydium.api.fetchPoolKeysById({ idList: [state.poolId] }).catch(() => []);
  const poolTable = apiPoolKeys?.id === state.poolId ? apiPoolKeys.lookupTableAccount : undefined;
  const raydiumTables = (await readLookupTables(connection, [new PublicKey("AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU"),
    ...(poolTable && poolTable !== PublicKey.default.toBase58() ? [new PublicKey(poolTable)] : []),
    ...built.lookupTableAddress.map((address) => new PublicKey(address))])).filter((table) => table.isActive());
  const [ataAInfo, ataBInfo] = await connection.getMultipleAccountsInfo(
    [new PublicKey(state.ataA), new PublicKey(state.ataB)], "confirmed");
  const raydiumInstructions = built.instructions;
  const openInstructions = raydiumInstructions.filter((ix) => ix.programId.toBase58() === state.programId);
  const openDiscriminator = createHash("sha256").update("global:open_position_with_token22_nft").digest().subarray(0, 8);
  const open = openInstructions[0];
  if (openInstructions.length !== 1 || !open || !open.data.subarray(0, 8).equals(openDiscriminator) ||
    open.keys[0]?.pubkey.toBase58() !== walletAddress ||
    open.keys[2]?.pubkey.toBase58() !== nftMintAddress ||
    !open.keys[2]?.isSigner ||
    open.keys[1]?.pubkey.toBase58() !== walletAddress) {
    throw new Error("Raydium instruction is not open_position_with_token22_nft for this wallet");
  }
  const routeInstructions = routes.flatMap((route) => [
    ...route.setupInstructions.map((ix) => instruction(ix, wallet)),
    instruction(route.swapInstruction, wallet),
    ...(route.cleanupInstruction ? [instruction(route.cleanupInstruction, wallet)] : []),
    ...route.otherInstructions.map((ix) => instruction(ix, wallet)),
  ]);
  await rejectUnselectedWalletTokenWrites(connection, wallet, routeInstructions,
    [state.inputAccount, state.ataA, state.ataB].filter((item): item is string => Boolean(item)));
  const routeTables = await readLookupTables(connection, routes.flatMap((route) =>
    Object.keys(route.addressesByLookupTableAddress || {}).map((key) => new PublicKey(key))));
  validateRouteTables(routes, routeTables);
  const directSol = state.inputKind === "native" ? legs.find((item) => !item.route && item.outputMint === NATIVE_SOL_MINT) : null;
  const wrapInstructions = directSol ? [
    createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB),
      wallet, new PublicKey(NATIVE_SOL_MINT), TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: wallet,
      toPubkey: new PublicKey(state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB), lamports: directSol.spend }),
    createSyncNativeInstruction(new PublicKey(state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB)),
  ] : [];
  const wrappedAta = directSol ? (state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB) : null;
  const createAtaInstructions = [
    ...(ataAInfo || wrappedAta === state.ataA ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataA), wallet,
      new PublicKey(state.mintA), new PublicKey(state.programA))]),
    ...(ataBInfo || wrappedAta === state.ataB ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataB), wallet,
      new PublicKey(state.mintB), new PublicKey(state.programB))]),
  ];
  const tables = [...new Map([...routeTables, ...raydiumTables]
    .map((table) => [table.key.toBase58(), table])).values()];
  const simulationBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const baseInstructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...routeInstructions, ...wrapInstructions, ...createAtaInstructions, ...raydiumInstructions];
  const compile = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({
    payerKey: wallet, recentBlockhash: simulationBlockhash, instructions,
  }).compileToV0Message(tables));
  const tip = await fetchBeamTipAddress();
  const chosen = chooseBeamTransaction(
    compile(baseInstructions),
    tip ? compile([...baseInstructions, beamTipInstruction(wallet, tip.address, tip.lamports)]) : null,
  );
  const simulated = chosen.transaction;
  if (simulated.message.header.numRequiredSignatures !== 2) {
    throw new Error("Open-position transaction must require wallet + NFT mint signatures");
  }
  transactionSize(simulated);
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired while constructing transaction, please resimulate");
  const rentLamports = BigInt(quote.rent.refundableLamports) + BigInt(quote.rent.nonRefundableLamports);
  const feeEstimate = await connection.getFeeForMessage(simulated.message, "confirmed");
  if (feeEstimate.value === null) throw new Error("Unable to estimate complete transaction network fee");
  const maxSolDebitLamports = (state.inputKind === "native" ? BigInt(quote.requested) : 0n)
    + rentLamports + BigInt(feeEstimate.value) + 100_000n
    + (chosen.included ? BigInt(BEAM_MIN_TIP_LAMPORTS) : 0n);
  const verified = await simulateAndVerifyOpenTransaction({
    connection, transaction: simulated, wallet, state, nftMint,
    tickLower: quote.tickLower, tickUpper: quote.tickUpper,
    requested: BigInt(quote.requested), expectedLiquidity: BigInt(quote.liquidity),
    maxSolDebitLamports, sigVerify: false,
  });
  const latest = await connection.getLatestBlockhash("confirmed");
  const restamped = restampVersionedTransaction(simulated, latest.blockhash, tables);
  try {
    restamped.sign(built.signers);
  } finally {
    built.signers[0].secretKey.fill(0);
  }
  const sizeBytes = transactionSize(restamped);
  const fee = await connection.getFeeForMessage(restamped.message, "confirmed");
  if (fee.value === null) throw new Error("Unable to estimate complete transaction network fee");
  const summary: OpenPositionSummary = {
    operation: "open-position", simulated: true, quote,
    nftMint: nftMintAddress, positionAccount: verified.positionAccount, nftAta: verified.nftAta,
    poolId: state.poolId, wallet: walletAddress, inputMint: state.inputMint, inputKind: state.inputKind,
    tickLower: quote.tickLower, tickUpper: quote.tickUpper, startingBalances: state.balances,
    simulatedEndingLiquidity: verified.endingLiquidity, simulatedInputSpent: verified.spentInput,
    simulatedDustA: verified.dustA, simulatedDustB: verified.dustB,
    simulatedSolDebitLamports: verified.solDebitLamports,
    maxSolDebitLamports: maxSolDebitLamports.toString(),
    feeLamports: fee.value, rentLamports: Number(rentLamports > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : rentLamports),
    sizeBytes, unitsConsumed: verified.unitsConsumed,
    beam: {
      included: chosen.included,
      tipLamports: chosen.included && tip ? tip.lamports : 0,
      tipAddress: chosen.included && tip ? tip.address.toBase58() : null,
      skippedReason: chosen.included ? null : chosen.skippedReason,
    },
    ...stampPreparedBlockhash(latest),
  };
  if (BigInt(MIN_SOL_LAMPORTS) + BigInt(summary.rentLamports) + BigInt(fee.value) > BigInt(state.solLamports)
    && state.inputKind !== "native") {
    throw new Error("Insufficient SOL remaining after simulated open-position rent and fees");
  }
  return { summary, transaction: restamped };
}
