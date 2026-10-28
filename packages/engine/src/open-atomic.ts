import { swapRouteInstructions, rejectUnselectedWalletTokenWrites } from "./swap";
import { createHash } from "node:crypto";
import BN from "bn.js";
import { ClmmInstrument, Raydium } from "@raydium-io/raydium-sdk-v2";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey, SystemProgram,
  type AccountInfo, type Connection,
} from "@solana/web3.js";
import { DEFAULT_RESALE_FLOOR_BPS, MIN_SOL_LAMPORTS, NATIVE_SOL_MINT, USDC_MINT } from "./ids";
import { restampVersionedTransaction, stampPreparedBlockhash } from "./fresh-blockhash";
import { validateRouteTables } from "./transaction-helpers";
import { assertOpenTransactionSize, compactAtaInstructions, compileCompactOpenTransaction, OpenTransactionSizeError, openLookupTableReader } from "./open-transaction";
import { defaultRpcConnection, rpcConnection } from "./rpc";
import { estimateFeeForMessage, OPEN_FEE_ESTIMATE_MESSAGE } from "./rpc/fee-estimate";
import { JupiterNoRouteError, type BuildRoute } from "./swap/jupiter";
import { BEAM_MIN_TIP_LAMPORTS, beamTipInstruction, chooseBeamTransaction, fetchBeamTipAddress } from "./solami-beam";
import { jupiterRelayActive } from "./jupiter/client";
import { getOpenPositionQuoteBundle, type OpenSwapStrategy } from "./open-quote";
import { TargetPoolProjectionError } from "./target-pool-projection";
import { simulateAndVerifyOpenTransaction } from "./open-simulation";
import { readSwapFeeConfig, collectInputAssetFee, wrapNativeSolInstructions, type FeeCollection, feeRecipientRent } from "./swap";
import type { OpenRangeInput } from "./open-range";
import { readOpenPoolState, type OpenPoolState, type OpenPositionSelection } from "./open-state";
import type { OpenPositionSummary } from "./open-types";
import { JUPITER_MAX_ACCOUNTS, type JupiterRouteConstraints } from "./jupiter-route-retry";
import { atomicComputeUnitLimitInstruction } from "./transaction-limits";

export type OpenPositionBuildOptions = {
  enforceResaleFloor?: boolean;
  /** Injected RPC connection; defaults to the host-configured `rpcConnection()`. */
  connection?: Connection;
  /** Sponsored mode: base58 fee payer that pays network fees and all new-account rent. Omit (or pass the wallet) for owner mode. */
  feePayer?: string;
  /**
   * Client-supplied position NFT mint public key. The engine never generates or
   * holds the mint secret; the client signs this key after the wallet (Phantom
   * multi-signer recipe). Required.
   */
  nftMint?: string;
};

/** On-curve position NFT mint the client will sign after the wallet. */
export function parseClientNftMint(value: unknown): PublicKey {
  if (typeof value !== "string" || !value) throw new Error("Position NFT mint is required");
  try {
    const mint = new PublicKey(value);
    if (!mint.equals(PublicKey.default) && PublicKey.isOnCurve(mint.toBytes())) return mint;
  } catch { /* Invalid base58 is reported with the same public message. */ }
  throw new Error("Invalid position NFT mint");
}

function reservedOpenAccounts(
  wallet: PublicKey,
  payer: PublicKey,
  state: OpenPoolState,
  feeWallet: PublicKey | null,
): PublicKey[] {
  const optional = [state.vaultA, state.vaultB, state.inputAccount, feeWallet?.toBase58() ?? null];
  return [
    wallet, payer,
    new PublicKey(state.poolId), new PublicKey(state.programId),
    new PublicKey(state.mintA), new PublicKey(state.mintB),
    new PublicKey(state.ataA), new PublicKey(state.ataB),
    new PublicKey(state.programA), new PublicKey(state.programB),
    new PublicKey(state.inputMint),
    ...optional.filter((value): value is string => Boolean(value)).map((value) => new PublicKey(value)),
    new PublicKey(NATIVE_SOL_MINT), new PublicKey(USDC_MINT),
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SystemProgram.programId, PublicKey.default,
  ];
}

function assertFreshClientNftMint(
  mint: PublicKey,
  account: AccountInfo<Buffer> | null,
  reserved: PublicKey[],
) {
  if (reserved.some((key) => key.equals(mint))) {
    throw new Error("Position NFT mint collides with a wallet or pool account");
  }
  if (account) throw new Error("Position NFT mint already exists");
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
  routeMaxAccounts: number | JupiterRouteConstraints,
  resources: OpenResources,
  strategy: OpenSwapStrategy,
  enforceResaleFloor: boolean,
  feePayerAddress: string | undefined,
  nftMint: PublicKey,
) {
  const { connection } = resources;
  const wallet = new PublicKey(walletAddress);
  // Sponsored mode: a separate fee payer signs as message payer and funds every new account
  // (ATAs, position NFT mint/account, fee-recipient ATA). Owner mode keeps `payer === wallet`, which
  // leaves every instruction and message byte identical to the original single-payer engine.
  const payer = feePayerAddress && feePayerAddress !== walletAddress ? new PublicKey(feePayerAddress) : wallet;
  const sponsored = !payer.equals(wallet);
  const { quote, legs, state } = await getOpenPositionQuoteBundle(
    walletAddress, selection, amount, range, floorBps, toleranceBps, routeMaxAccounts, resources.state, strategy,
  );
  if (enforceResaleFloor && !quote.passesFloor) {
    throw new Error(quote.warning || "Conservative immediate resale ratio below selected threshold");
  }
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired, please resimulate");
  const routes = legs.flatMap((item) => item.route ? [item.route] : []);
  const feeConfig = readSwapFeeConfig();
  const protocolFee = legs.filter(item => item.inputMint === state.inputMint).reduce((sum, item) => sum + (item.feeAmount ?? 0n), 0n);
  if ((quote.feeBps ?? 0) !== feeConfig.bps || BigInt(quote.feeAmount ?? "0") !== protocolFee ||
    (quote.feeWallet ?? null) !== (feeConfig.wallet?.toBase58() ?? null)) {
    throw new Error("Quote protocol fee does not match configuration");
  }
  if (legs.length !== (quote.rangeSide === "inside" ? 2 : 1) || legs.some((item) =>
    ![state.mintA, state.mintB].includes(item.outputMint) ||
    item.route && (item.route.inputMint !== item.inputMint || item.route.outputMint !== item.outputMint ||
      BigInt(item.route.inAmount) !== item.spend - (item.feeAmount ?? 0n)))) {
    throw new Error("Swap route does not match selected assets or pool");
  }
  if (strategy !== "parallel" && quote.rangeSide === "inside" && ![state.mintA, state.mintB].includes(state.inputMint)) {
    const [primary, secondary] = legs;
    const primaryMint = strategy === "sequential" ? state.mintA : state.mintB;
    const secondaryMint = strategy === "sequential" ? state.mintB : state.mintA;
    if (!primary?.route || !secondary?.route || primary.inputMint !== state.inputMint || primary.outputMint !== primaryMint ||
      secondary.inputMint !== primaryMint || secondary.outputMint !== secondaryMint || primary.spend !== BigInt(quote.requested) ||
      secondary.spend >= BigInt(primary.route.otherAmountThreshold) ||
      primary.minOut !== BigInt(primary.route.otherAmountThreshold) - secondary.spend) {
      throw new Error("Sequential swap amounts do not match conservative output limits");
    }
  } else if (legs.some(item => item.inputMint !== state.inputMint) || legs.reduce((total, item) => total + item.spend, 0n) !== BigInt(quote.requested)) {
    throw new Error("Swap spend does not match selected input amount");
  }
  const [nftMintInfo] = await connection.getMultipleAccountsInfo([nftMint], "confirmed");
  assertFreshClientNftMint(nftMint, nftMintInfo ?? null, reservedOpenAccounts(wallet, payer, state, feeConfig.wallet));
  const { poolInfo, poolKeys } = await resources.pool();
  if (poolInfo.programId !== state.programId || poolInfo.mintA.address !== state.mintA ||
    poolInfo.mintB.address !== state.mintB || poolInfo.config.tickSpacing !== state.tickSpacing) {
    throw new Error("Raydium pool program, mint, or tick spacing mismatch");
  }
  // Token-2022 NFT (no Metaplex metadata ix) keeps the v0 message smaller so a
  // Jupiter swap + open can still fit in 1,232 bytes. The client supplies the
  // mint pubkey (Raydium getEphemeralSigners) so this builder returns no local
  // signers; the wallet signs first, then the client adds the mint signature.
  const built = await ClmmInstrument.openPositionFromLiquidityInstructions({
    poolInfo, poolKeys,
    ownerInfo: { wallet, tokenAccountA: new PublicKey(state.ataA), tokenAccountB: new PublicKey(state.ataB) },
    tickLower: quote.tickLower, tickUpper: quote.tickUpper,
    liquidity: new BN(quote.liquidity),
    amountMaxA: new BN(quote.amountMaxA), amountMaxB: new BN(quote.amountMaxB),
    base: null, withMetadata: "no-create", nft2022: true,
    getEphemeralSigners: async (count: number) => {
      if (count !== 1) throw new Error("Raydium open-position must request exactly one ephemeral signer (the position NFT mint)");
      return [nftMint];
    },
  });
  if (sponsored) {
    if (state.inputKind === "native") throw new Error("Sponsored open-position does not accept native SOL input");
    const sdkOpen = built.instructions.filter((ix) => ix.programId.toBase58() === state.programId);
    // open_position_with_token22_nft account 0 is the rent payer (signer, writable); account 1 stays the NFT owner.
    for (const ix of sdkOpen) {
      if (ix.keys[0]?.pubkey.toBase58() === walletAddress) ix.keys[0] = { ...ix.keys[0], pubkey: payer };
    }
  }
  if (built.signers.length) {
    for (const signer of built.signers) signer.secretKey.fill(0);
    throw new Error("Raydium open-position must not return local signers when the NFT mint is client-supplied");
  }
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
    open.keys[0]?.pubkey.toBase58() !== payer.toBase58() ||
    open.keys[2]?.pubkey.toBase58() !== nftMintAddress ||
    !open.keys[2]?.isSigner ||
    open.keys[1]?.pubkey.toBase58() !== walletAddress) {
    throw new Error("Raydium instruction is not open_position_with_token22_nft for this wallet");
  }
  const feeRoutes: BuildRoute[] = [];
  const collections: FeeCollection[] = [];
  const routeInstructions = (await Promise.all(legs.map(async item => {
    if (!item.route) return [];
    const secondaryFee = item.inputMint !== state.inputMint && feeConfig.wallet && item.feeAmount > 0n
      ? await collectInputAssetFee(connection, { payer, owner: wallet, recipient: feeConfig.wallet,
        amount: item.feeAmount, kind: "token", mint: new PublicKey(item.inputMint),
        source: new PublicKey(item.inputMint === state.mintA ? state.ataA : state.ataB),
        decimals: item.inputMint === state.mintA ? state.decimalsA : state.decimalsB,
        program: new PublicKey(item.inputMint === state.mintA ? state.programA : state.programB) }) : { instructions: [], routes: [] };
    collections.push(secondaryFee);
    feeRoutes.push(...secondaryFee.routes);
    return [...secondaryFee.instructions, ...swapRouteInstructions([item.route], wallet)];
  }))).flat();
  const nativeAta = state.inputKind === "native"
    ? getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID) : null;
  await rejectUnselectedWalletTokenWrites(connection, wallet, routeInstructions,
    [state.inputAccount, state.ataA, state.ataB, nativeAta?.toBase58(), ...collections.flatMap(c => c.receiveOnlyAccounts ?? [])].filter((item): item is string => Boolean(item)));
  const routeTables = await resources.readTables(routes.flatMap((route) =>
    Object.keys(route.addressesByLookupTableAddress || {}).map((key) => new PublicKey(key))));
  validateRouteTables(routes, routeTables);
  // Wrap the full native SOL input once, then TransferChecked the protocol fee
  // from the user's wSOL ATA. Jupiter routes are built without wrap/close.
  const wrapInstructions = nativeAta ? wrapNativeSolInstructions(wallet, BigInt(quote.requested)) : [];
  if (protocolFee > 0n && state.inputKind === "token" && (!state.inputAccount || !state.inputTokenProgram)) {
    throw new Error("Protocol fee requires the selected input token account");
  }
  const feeInstructions = feeConfig.wallet && protocolFee > 0n
    ? await collectInputAssetFee(connection, state.inputKind === "native"
      ? { payer, owner: wallet, recipient: feeConfig.wallet, amount: protocolFee, kind: "native" }
      : {
        payer, owner: wallet, recipient: feeConfig.wallet, amount: protocolFee, kind: "token",
        mint: new PublicKey(state.inputMint), source: new PublicKey(state.inputAccount!),
        decimals: state.inputDecimals, program: new PublicKey(state.inputTokenProgram!),
      })
    : { instructions: [], routes: [] };
  collections.push(feeInstructions);
  feeRoutes.push(...feeInstructions.routes);
  const feeTables = await resources.readTables(feeRoutes.flatMap(route => Object.keys(route.addressesByLookupTableAddress || {}).map(key => new PublicKey(key))));
  validateRouteTables(feeRoutes, feeTables);
  await rejectUnselectedWalletTokenWrites(connection, wallet, [...feeInstructions.instructions, ...routeInstructions],
    [state.inputAccount, state.ataA, state.ataB, nativeAta?.toBase58(), ...collections.flatMap(c => c.receiveOnlyAccounts ?? [])].filter((item): item is string => Boolean(item)));
  const wrappedAta = nativeAta?.toBase58() ?? null;
  const cleanupInstructions = nativeAta && ![state.mintA, state.mintB].includes(NATIVE_SOL_MINT)
    ? [createCloseAccountInstruction(nativeAta, wallet, wallet)] : [];
  const createAtaInstructions = [
    ...(ataAInfo || wrappedAta === state.ataA ? [] : [createAssociatedTokenAccountIdempotentInstruction(payer, new PublicKey(state.ataA), wallet,
      new PublicKey(state.mintA), new PublicKey(state.programA))]),
    ...(ataBInfo || wrappedAta === state.ataB ? [] : [createAssociatedTokenAccountIdempotentInstruction(payer, new PublicKey(state.ataB), wallet,
      new PublicKey(state.mintB), new PublicKey(state.programB))]),
  ];
  const availableTables = [...new Map([...routeTables, ...feeTables, ...raydiumTables]
    .map((table) => [table.key.toBase58(), table])).values()];
  const simulationBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const instructions = await compactAtaInstructions(connection, [
    atomicComputeUnitLimitInstruction(),
    ...wrapInstructions, ...feeInstructions.instructions, ...createAtaInstructions, ...routeInstructions, ...raydiumInstructions, ...cleanupInstructions,
  ]);
  assertOpenTransactionSize(compileCompactOpenTransaction({ payerKey: payer, recentBlockhash: simulationBlockhash, instructions }, availableTables).transaction);
  // Beam tips are paid by the wallet; sponsored transactions never carry one.
  const tip = sponsored ? null : await fetchBeamTipAddress();
  const messageInput = { payerKey: payer, recentBlockhash: simulationBlockhash, instructions };
  const withoutTip = compileCompactOpenTransaction(messageInput, availableTables);
  assertOpenTransactionSize(withoutTip.transaction);
  const withTip = tip
    ? compileCompactOpenTransaction({
      ...messageInput,
      instructions: [...instructions, beamTipInstruction(wallet, tip.address, tip.lamports)],
    }, availableTables)
    : null;
  const chosen = chooseBeamTransaction(withoutTip.transaction, withTip?.transaction ?? null);
  const simulated = chosen.transaction;
  const tables = chosen.included && withTip ? withTip.tables : withoutTip.tables;
  if (simulated.message.header.numRequiredSignatures !== (sponsored ? 3 : 2)) {
    throw new Error(sponsored
      ? "Sponsored open-position transaction must require fee payer + wallet + NFT mint signatures"
      : "Open-position transaction must require wallet + NFT mint signatures");
  }
  assertOpenTransactionSize(simulated);
  if (Date.now() >= quote.expiresAt) throw new Error("Quote expired while constructing transaction, please resimulate");
  const rentLamports = BigInt(quote.rent.refundableLamports) + BigInt(quote.rent.nonRefundableLamports)
    + BigInt(quote.rent.walletTokenAccountLamports ?? "0");
  const feeEstimateValue = await estimateFeeForMessage(connection, simulated.message, "confirmed", {
    fallback: defaultRpcConnection, emptyError: OPEN_FEE_ESTIMATE_MESSAGE,
  });
  const feeAtaRent = feeConfig.wallet
    ? await feeRecipientRent(connection, feeConfig.wallet, instructions) : 0n;
  // Sponsored: the fee payer covers rent and network fees, so the wallet's SOL must not move at all.
  const maxSolDebitLamports = sponsored ? 0n : (state.inputKind === "native" ? BigInt(quote.requested) : 0n)
    + rentLamports + feeAtaRent + BigInt(feeEstimateValue) + 100_000n
    + (chosen.included ? BigInt(BEAM_MIN_TIP_LAMPORTS) : 0n);
  const verified = await simulateAndVerifyOpenTransaction({
    connection, transaction: simulated, wallet, state, nftMint,
    tickLower: quote.tickLower, tickUpper: quote.tickUpper,
    requested: BigInt(quote.requested), expectedLiquidity: BigInt(quote.liquidity),
    maxSolDebitLamports, sigVerify: false,
    ...(sponsored ? { minRemainingSolLamports: 0n } : {}),
  });
  const latest = await connection.getLatestBlockhash("confirmed");
  const restamped = restampVersionedTransaction(simulated, latest.blockhash, tables);
  const sizeBytes = assertOpenTransactionSize(restamped);
  const fee = await estimateFeeForMessage(connection, restamped.message, "confirmed", {
    fallback: defaultRpcConnection, emptyError: OPEN_FEE_ESTIMATE_MESSAGE,
  });
  const summary: OpenPositionSummary = {
    operation: "open-position", simulated: true, quote,
    nftMint: nftMintAddress, positionAccount: verified.positionAccount, nftAta: verified.nftAta,
    poolId: state.poolId, wallet: walletAddress, inputMint: state.inputMint, inputKind: state.inputKind,
    tickLower: quote.tickLower, tickUpper: quote.tickUpper, startingBalances: state.balances,
    simulatedEndingLiquidity: verified.endingLiquidity, simulatedInputSpent: verified.spentInput,
    simulatedDustA: verified.dustA, simulatedDustB: verified.dustB,
    simulatedSolDebitLamports: verified.solDebitLamports,
    maxSolDebitLamports: maxSolDebitLamports.toString(),
    feeLamports: fee, rentLamports: Number(rentLamports > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : rentLamports),
    sizeBytes, unitsConsumed: verified.unitsConsumed,
    beam: {
      included: chosen.included,
      tipLamports: chosen.included && tip ? tip.lamports : 0,
      tipAddress: chosen.included && tip ? tip.address.toBase58() : null,
      skippedReason: chosen.included ? null : chosen.skippedReason,
    },
    ...stampPreparedBlockhash(latest),
  };
  if (!sponsored && BigInt(MIN_SOL_LAMPORTS) + BigInt(summary.rentLamports) + BigInt(fee) > BigInt(state.solLamports)
    && state.inputKind !== "native") {
    throw new Error("Insufficient SOL remaining after simulated open-position rent and fees");
  }
  return { summary, transaction: restamped };
}

export async function buildAndSimulateOpenPosition(
  walletAddress: string,
  selection: OpenPositionSelection,
  amount: string,
  range: OpenRangeInput,
  floorBps = DEFAULT_RESALE_FLOOR_BPS,
  toleranceBps?: number,
  options?: OpenPositionBuildOptions,
) {
  // A swap's account budget is not a byte budget for swap + LP together.
  // Re-quote and re-size all legs for each attempt so the liquidity, minimum
  // outputs and price-impact guards match the route we actually simulate.
  const nftMint = parseClientNftMint(options?.nftMint);
  const connection = options?.connection ?? rpcConnection();
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
  let lastProjectionError: TargetPoolProjectionError | undefined;
  const strategies = ![state.mintA, state.mintB].includes(state.inputMint)
    ? ["parallel", "sequential-b", "sequential"] as const : ["parallel"] as const;
  // Pool-token secondary legs prefer the shared own-pool direct route.
  // Try a materially smaller budget and the shared first swap early, rather
  // than rebuilding several similar large two-swap routes first. Either pool
  // token can be the primary: the two directions may have different route sizes.
  const sequentialDirect = strategies.filter(strategy => strategy !== "parallel")
    .map(strategy => ({ constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.direct }, strategy }));
  const parallelWide = { constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.wide }, strategy: "parallel" as const };
  // With browser-fetched Jupiter responses, the parallel/wide attempt replays the
  // exact quotes the preview already fetched, so it goes first (only swap-instructions
  // are new). Server-keyed callers keep the smaller-transaction-first order.
  const attempts = [
    ...(jupiterRelayActive() ? [parallelWide, ...sequentialDirect] : [...sequentialDirect, parallelWide]),
    ...strategies.map(strategy => ({ constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.compact }, strategy })),
    ...strategies.map(strategy => ({ constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.medium }, strategy })),
  ];
  for (const { constraints, strategy } of attempts) {
    try {
      return await buildOpenPositionAttempt(
        walletAddress, selection, amount, range, floorBps, toleranceBps, constraints, resources, strategy,
        options?.enforceResaleFloor !== false, options?.feePayer, nftMint,
      );
    } catch (error) {
      if (error instanceof JupiterNoRouteError) continue;
      // Sequential strategies send their second hop through the target pool itself, which can push
      // its price out of a narrow range even though the parallel legs (what /open-quote priced) avoid
      // the pool entirely. Every attempt re-runs the same guard, so trying the next strategy relaxes nothing.
      if (error instanceof TargetPoolProjectionError) {
        lastProjectionError = error;
        continue;
      }
      if (!(error instanceof OpenTransactionSizeError)) throw error;
      lastSizeError = error;
    }
  }
  throw lastProjectionError ?? lastSizeError ?? new JupiterNoRouteError();
}
