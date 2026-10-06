import "server-only";

import { createHash } from "node:crypto";
import BN from "bn.js";
import { ClmmInstrument, PersonalPositionLayout, Raydium } from "@raydium-io/raydium-sdk-v2";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_SOL_MINT, QUOTE_TTL_MS } from "./ids";
import { instruction, readLookupTables, validateRouteTables } from "./transaction-helpers";
import { rpcConnection } from "./rpc";
import { getSelectedQuoteBundle } from "./selected-quote";
import { simulateAndVerifySelectedTransaction } from "./selected-simulation";
import type { PositionSelection } from "./selected-state";

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

export async function buildAndSimulateSelectedZap(
  walletAddress: string, selection: PositionSelection, amount: string, floorBps: number,
  toleranceBps?: number,
) {
  const connection = rpcConnection();
  const wallet = new PublicKey(walletAddress);
  const { quote, legs, state } = await getSelectedQuoteBundle(walletAddress, selection, amount, floorBps, toleranceBps);
  if (!quote.passesFloor) throw new Error("Conservative immediate resale ratio below selected threshold");
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired, please resimulate");
  const routes = legs.flatMap((item) => item.route ? [item.route] : []);
  if (legs.length !== (state.rangeSide === "inside" ? 2 : 1) || legs.some((item) =>
    item.inputMint !== state.inputMint || ![state.mintA, state.mintB].includes(item.outputMint) ||
    item.route && (item.route.inputMint !== state.inputMint || item.route.outputMint !== item.outputMint ||
      BigInt(item.route.inAmount) !== item.spend))) throw new Error("Swap route does not match selected assets or position");
  const positionInfo = await connection.getAccountInfo(new PublicKey(state.positionAccount), "confirmed");
  if (!positionInfo || positionInfo.owner.toBase58() !== state.programId) throw new Error("Selected position account has changed");
  const ownerPosition = PersonalPositionLayout.decode(positionInfo.data);
  if (ownerPosition.nftMint.toBase58() !== state.positionMint || ownerPosition.poolId.toBase58() !== state.poolId ||
    ownerPosition.tickLower !== state.tickLower || ownerPosition.tickUpper !== state.tickUpper ||
    ownerPosition.liquidity.toString() !== state.liquidity) throw new Error("Selected position identity or liquidity has changed");
  const raydium = await Raydium.load({ connection, owner: wallet, disableLoadToken: true });
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(state.poolId);
  if (poolInfo.programId !== state.programId || poolInfo.mintA.address !== state.mintA ||
    poolInfo.mintB.address !== state.mintB) throw new Error("Raydium pool program or mint mismatch");
  // Build increase_liquidity_v2 directly against the wallet's derived ATAs.
  // The SDK helper returns no token account (and then crashes) when an ATA
  // does not exist yet, e.g. a wallet that has never held WSOL. Missing ATAs
  // are created idempotently below, after the swap legs have run.
  const built = ClmmInstrument.increasePositionFromLiquidityInstructions({
    poolInfo, poolKeys, ownerPosition,
    ownerInfo: { wallet, tokenAccountA: new PublicKey(state.ataA), tokenAccountB: new PublicKey(state.ataB) },
    liquidity: new BN(quote.liquidity), amountMaxA: new BN(quote.amountMaxA),
    amountMaxB: new BN(quote.amountMaxB), nft2022: state.nftProgram === TOKEN_2022_PROGRAM_ID.toBase58(),
  });
  if (built.signers.length) throw new Error("Raydium liquidity addition requires additional signers, atomic transaction stopped");
  // Raydium's mainnet common ALT plus the pool's own ALT (same sources as the
  // compound builder), freshly resolved through RPC. Compilation only
  // compresses exact instruction keys; no API data controls writes.
  const [apiPoolKeys] = await raydium.api.fetchPoolKeysById({ idList: [state.poolId] }).catch(() => []);
  const poolTable = apiPoolKeys?.id === state.poolId ? apiPoolKeys.lookupTableAccount : undefined;
  const raydiumTables = (await readLookupTables(connection, [new PublicKey("AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU"),
    ...(poolTable && poolTable !== PublicKey.default.toBase58() ? [new PublicKey(poolTable)] : []),
    ...built.lookupTableAddress.map((address) => new PublicKey(address))])).filter((table) => table.isActive());
  const [ataAInfo, ataBInfo] = await connection.getMultipleAccountsInfo(
    [new PublicKey(state.ataA), new PublicKey(state.ataB)], "confirmed");
  const raydiumInstructions = built.instructions;
  const addInstructions = raydiumInstructions.filter((ix) => ix.programId.toBase58() === state.programId);
  const addDiscriminator = createHash("sha256").update("global:increase_liquidity_v2").digest().subarray(0, 8);
  const add = addInstructions[0];
  if (addInstructions.length !== 1 || !add || !add.data.subarray(0, 8).equals(addDiscriminator) ||
    add.keys[0]?.pubkey.toBase58() !== walletAddress || add.keys[2]?.pubkey.toBase58() !== state.poolId ||
    add.keys[4]?.pubkey.toBase58() !== state.positionAccount) {
    throw new Error("Raydium instruction is not increase_liquidity_v2 on selected position");
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
  // The direct SOL wrap above already creates its ATA idempotently.
  const wrappedAta = directSol ? (state.mintA === NATIVE_SOL_MINT ? state.ataA : state.ataB) : null;
  const createAtaInstructions = [
    ...(ataAInfo || wrappedAta === state.ataA ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataA), wallet,
      new PublicKey(state.mintA), new PublicKey(state.programA))]),
    ...(ataBInfo || wrappedAta === state.ataB ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(state.ataB), wallet,
      new PublicKey(state.mintB), new PublicKey(state.programB))]),
  ];
  const tables = [...new Map([...routeTables, ...raydiumTables]
    .map((table) => [table.key.toBase58(), table])).values()];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: wallet, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...routeInstructions, ...wrapInstructions, ...createAtaInstructions, ...raydiumInstructions],
  }).compileToV0Message(tables));
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
  const verified = await simulateAndVerifySelectedTransaction({
    connection, transaction, wallet, state, requested: BigInt(quote.requested),
    expectedLiquidity: BigInt(quote.liquidity), sigVerify: false,
  });
  const fee = await connection.getFeeForMessage(transaction.message, "confirmed");
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
  };
  return { summary, transaction };
}
