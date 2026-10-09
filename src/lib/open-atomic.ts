import "server-only";

import { createHash } from "node:crypto";
import BN from "bn.js";
import { ClmmInstrument, Raydium } from "@raydium-io/raydium-sdk-v2";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  ComputeBudgetProgram, PublicKey, SystemProgram,
  type Connection, type TransactionInstruction,
} from "@solana/web3.js";
import { DEFAULT_RESALE_FLOOR_BPS, MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";
import { restampVersionedTransaction, stampPreparedBlockhash } from "./fresh-blockhash";
import { instruction, validateRouteTables } from "./transaction-helpers";
import { assertOpenTransactionSize, compactAtaInstructions, compileCompactOpenTransaction, OpenTransactionSizeError, openLookupTableReader } from "./open-transaction";
import { rpcConnection } from "./rpc";
import { JupiterNoRouteError } from "./jupiter-route";
import { getOpenPositionQuoteBundle } from "./open-quote";
import { simulateAndVerifyOpenTransaction } from "./open-simulation";
import type { OpenRangeInput } from "./open-range";
import { readOpenPoolState, type OpenPoolState, type OpenPositionSelection } from "./open-state";
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

type OpenResources = {
  connection: Connection;
  state: OpenPoolState;
  pool: () => ReturnType<Awaited<ReturnType<typeof Raydium.load>>["clmm"]["getPoolInfoFromRpc"]>;
  poolTable: () => Promise<string | undefined>;
  readTables: ReturnType<typeof openLookupTableReader>;
};

async function buildOpenPositionAttempt(
  walletAddress: string,
  selection: OpenPositionSelection,
  amount: string,
  range: OpenRangeInput,
  floorBps: number,
  toleranceBps: number | undefined,
  routeMaxAccounts: number,
  resources: OpenResources,
  strategy: "parallel" | "sequential",
  enforceResaleFloor: boolean,
) {
  const { connection } = resources;
  const wallet = new PublicKey(walletAddress);
  const { quote, legs, state } = await getOpenPositionQuoteBundle(
    walletAddress, selection, amount, range, floorBps, toleranceBps, routeMaxAccounts, resources.state, strategy,
  );
  if (enforceResaleFloor && !quote.passesFloor) {
    throw new Error(quote.warning || "Conservative immediate resale ratio below selected threshold");
  }
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired, please resimulate");
  const routes = legs.flatMap((item) => item.route ? [item.route] : []);
  if (legs.length !== (quote.rangeSide === "inside" ? 2 : 1) || legs.some((item) =>
    ![state.mintA, state.mintB].includes(item.outputMint) ||
    item.route && (item.route.inputMint !== item.inputMint || item.route.outputMint !== item.outputMint ||
      BigInt(item.route.inAmount) !== item.spend))) {
    throw new Error("Swap route does not match selected assets or pool");
  }
  if (strategy === "sequential" && quote.rangeSide === "inside" && ![state.mintA, state.mintB].includes(state.inputMint)) {
    const [primary, secondary] = legs;
    if (!primary?.route || !secondary?.route || primary.inputMint !== state.inputMint || primary.outputMint !== state.mintA ||
      secondary.inputMint !== state.mintA || secondary.outputMint !== state.mintB || primary.spend !== BigInt(quote.requested) ||
      secondary.spend >= BigInt(primary.route.otherAmountThreshold) ||
      primary.minOut !== BigInt(primary.route.otherAmountThreshold) - secondary.spend) {
      throw new Error("Sequential swap amounts do not match conservative output limits");
    }
  } else if (legs.some(item => item.inputMint !== state.inputMint) || legs.reduce((total, item) => total + item.spend, 0n) !== BigInt(quote.requested)) {
    throw new Error("Swap spend does not match selected input amount");
  }
  const { poolInfo, poolKeys } = await resources.pool();
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
  try {
    const nftMint = built.signers[0].publicKey;
    const nftMintAddress = nftMint.toBase58();
    const poolTable = await resources.poolTable();
    const raydiumTables = (await resources.readTables([new PublicKey("AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU"),
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
    const routeTables = await resources.readTables(routes.flatMap((route) =>
      Object.keys(route.addressesByLookupTableAddress || {}).map((key) => new PublicKey(key))));
    validateRouteTables(routes, routeTables);
    // Fund WSOL once for both swap legs. Jupiter routes are built without their
    // own wrap/close sequence, which otherwise repeats transfers and ATA setup.
    const nativeAta = state.inputKind === "native"
      ? getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID) : null;
    const wrapInstructions = nativeAta ? [
      createAssociatedTokenAccountIdempotentInstruction(wallet, nativeAta, wallet, new PublicKey(NATIVE_SOL_MINT)),
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: nativeAta, lamports: BigInt(quote.requested) }),
      createSyncNativeInstruction(nativeAta),
    ] : [];
    const wrappedAta = nativeAta?.toBase58() ?? null;
    const cleanupInstructions = nativeAta && ![state.mintA, state.mintB].includes(NATIVE_SOL_MINT)
      ? [createCloseAccountInstruction(nativeAta, wallet, wallet)] : [];
    const createAtaInstructions = [
      ...(ataAInfo || wrappedAta === state.ataA ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataA), wallet,
        new PublicKey(state.mintA), new PublicKey(state.programA))]),
      ...(ataBInfo || wrappedAta === state.ataB ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataB), wallet,
        new PublicKey(state.mintB), new PublicKey(state.programB))]),
    ];
    const availableTables = [...new Map([...routeTables, ...raydiumTables]
      .map((table) => [table.key.toBase58(), table])).values()];
    const simulationBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const instructions = await compactAtaInstructions(connection, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...wrapInstructions, ...createAtaInstructions, ...routeInstructions, ...raydiumInstructions, ...cleanupInstructions,
    ]);
    const { transaction: simulated, tables } = compileCompactOpenTransaction({
      payerKey: wallet, recentBlockhash: simulationBlockhash, instructions,
    }, availableTables);
    if (simulated.message.header.numRequiredSignatures !== 2) {
      throw new Error("Open-position transaction must require wallet + NFT mint signatures");
    }
    assertOpenTransactionSize(simulated);
    if (Date.now() >= quote.expiresAt) throw new Error("Quote expired while constructing transaction, please resimulate");
    const rentLamports = BigInt(quote.rent.refundableLamports) + BigInt(quote.rent.nonRefundableLamports);
    const feeEstimate = await connection.getFeeForMessage(simulated.message, "confirmed");
    if (feeEstimate.value === null) throw new Error("Unable to estimate complete transaction network fee");
    const maxSolDebitLamports = (state.inputKind === "native" ? BigInt(quote.requested) : 0n)
      + rentLamports + BigInt(feeEstimate.value) + 100_000n;
    const verified = await simulateAndVerifyOpenTransaction({
      connection, transaction: simulated, wallet, state, nftMint,
      tickLower: quote.tickLower, tickUpper: quote.tickUpper,
      requested: BigInt(quote.requested), expectedLiquidity: BigInt(quote.liquidity),
      maxSolDebitLamports, sigVerify: false,
    });
    const latest = await connection.getLatestBlockhash("confirmed");
    const restamped = restampVersionedTransaction(simulated, latest.blockhash, tables);
    restamped.sign(built.signers);
    const sizeBytes = assertOpenTransactionSize(restamped);
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
      ...stampPreparedBlockhash(latest),
    };
    if (BigInt(MIN_SOL_LAMPORTS) + BigInt(summary.rentLamports) + BigInt(fee.value) > BigInt(state.solLamports)
      && state.inputKind !== "native") {
      throw new Error("Insufficient SOL remaining after simulated open-position rent and fees");
    }
    return { summary, transaction: restamped };
  } finally {
    built.signers[0].secretKey.fill(0);
  }
}

export async function buildAndSimulateOpenPosition(
  walletAddress: string,
  selection: OpenPositionSelection,
  amount: string,
  range: OpenRangeInput,
  floorBps = DEFAULT_RESALE_FLOOR_BPS,
  toleranceBps?: number,
  options?: { enforceResaleFloor?: boolean },
) {
  // A swap's account budget is not a byte budget for swap + LP together.
  // Re-quote and re-size all legs for each attempt so the liquidity, minimum
  // outputs and price-impact guards match the route we actually simulate.
  const connection = rpcConnection();
  const state = await readOpenPoolState(walletAddress, selection, connection);
  let raydium: ReturnType<typeof Raydium.load> | undefined;
  const sdk = () => raydium ??= Raydium.load({ connection, owner: new PublicKey(walletAddress), disableLoadToken: true });
  let pool: ReturnType<OpenResources["pool"]> | undefined;
  let poolTable: Promise<string | undefined> | undefined;
  const resources: OpenResources = {
    connection, state, readTables: openLookupTableReader(connection),
    pool: () => pool ??= sdk().then(sdk => sdk.clmm.getPoolInfoFromRpc(selection.poolId)),
    poolTable: () => poolTable ??= sdk().then(async sdk => {
      const [keys] = await sdk.api.fetchPoolKeysById({ idList: [selection.poolId] }).catch(() => []);
      return keys?.id === selection.poolId ? keys.lookupTableAccount : undefined;
    }),
  };
  let lastSizeError: OpenTransactionSizeError | undefined;
  const attempts = [
    ...[48, 40, 32, 24].map(maxAccounts => ({ maxAccounts, strategy: "parallel" as const })),
    ...(![state.mintA, state.mintB].includes(state.inputMint)
      ? [32, 24].map(maxAccounts => ({ maxAccounts, strategy: "sequential" as const })) : []),
  ];
  for (const { maxAccounts, strategy } of attempts) {
    try {
      return await buildOpenPositionAttempt(
        walletAddress, selection, amount, range, floorBps, toleranceBps, maxAccounts, resources, strategy,
        options?.enforceResaleFloor !== false,
      );
    } catch (error) {
      if (error instanceof JupiterNoRouteError) continue;
      if (!(error instanceof OpenTransactionSizeError)) throw error;
      lastSizeError = error;
    }
  }
  throw lastSizeError ?? new JupiterNoRouteError();
}
