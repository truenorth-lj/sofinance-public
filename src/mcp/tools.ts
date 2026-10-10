import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { discoverWallet } from "../lib/wallet-discovery";
import { getSelectedQuoteBundle } from "../lib/selected-quote";
import { buildAndSimulateSelectedZap } from "../lib/selected-atomic";
import { buildAndSimulateCompound } from "../lib/compound-atomic";
import { issueSelectedPermit } from "../lib/selected-permit";
import { issueCompoundPermit } from "../lib/compound-permit";
import { verifySelectedPermit } from "../lib/selected-permit";
import { verifyCompoundPermit } from "../lib/compound-permit";
import { simulateAndVerifySelectedTransaction } from "../lib/selected-simulation";
import { readSelectedPositionState } from "../lib/selected-state";
import { rpcConnection } from "../lib/rpc";
import { sendSignedCompoundTransaction } from "../lib/compound-send";
import { CompoundSendError, notSentRetryMessage, sanitizePublicError } from "../lib/public-error";
import type { CompoundSummary } from "../lib/compound-types";
import { discoverRwaPairs } from "../lib/rwa-pairs";
import { getPositionPerformance as readPositionPerformance } from "../lib/position-performance";
import { createSignToken } from "../lib/pending-sign-token";
import { buildOpenPositionUrl, buildSignUrl } from "../lib/public-urls";
import { OPEN_RANGE_PRESETS } from "../lib/open-range-presets";
import { rangeInputFromFields } from "../lib/open-range";
import { getOpenPositionQuoteBundle } from "../lib/open-quote";
import { buildAndSimulateOpenPosition } from "../lib/open-atomic";
import { issueOpenPositionPermit } from "../lib/open-permit";
import { submitOpenPositionFromParts } from "../lib/open-send";
import type { OpenPositionSummary } from "../lib/open-types";
import { getPoolActivitySnapshot } from "../lib/solami-blur";
import { readPositionRangeFacts } from "../lib/position-range-onchain";
import { blurPriceToBPerA, rangeStatusFromPrice } from "../lib/position-range-status";
import type {
  ListPositionsInput,
  QuoteAddLiquidityInput,
  PrepareTransactionInput,
  QuoteCompoundInput,
  SubmitSignedTransactionInput,
  SubmitCompoundTransactionInput,
  ListRwaPairsInput,
  GetPositionPerformanceInput,
  GetPoolActivityInput,
  GetPositionRangeStatusInput,
  QuoteOpenPositionInput,
  PrepareOpenPositionInput,
  SubmitOpenPositionInput,
} from "./schemas";

/**
 * List all Raydium CLMM positions and assets for a wallet.
 * Returns positions (NFTs), eligible assets, and balances.
 * 
 * Safety: Read-only operation, no private keys required.
 */
export async function listPositions(input: ListPositionsInput) {
  const discovery = await discoverWallet(input.wallet);
  
  return {
    wallet: discovery.wallet,
    slot: discovery.slot,
    fetchedAt: discovery.fetchedAt,
    positions: discovery.positions.map(pos => ({
      positionMint: pos.positionMint,
      positionAccount: pos.positionAccount,
      poolId: pos.poolId,
      mintA: pos.mintA,
      mintB: pos.mintB,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      tickCurrent: pos.tickCurrent,
      rangeSide: pos.rangeSide,
      liquidity: pos.liquidity,
    })),
    assets: discovery.assets.map(asset => ({
      kind: asset.kind,
      mint: asset.mint,
      tokenProgram: asset.tokenProgram,
      decimals: asset.decimals,
      balance: asset.balance,
      totalBalance: asset.totalBalance,
      account: asset.account,
      eligible: asset.eligible,
      reason: asset.reason,
    })),
  };
}

/**
 * Get a quote for adding liquidity to a position.
 * Includes swap routes, price impact, resale protection, and estimated outputs.
 * 
 * Safety: Read-only, verifies NFT ownership, pool state, and balance.
 * Failure modes: Insufficient balance, high price impact, quote expiration.
 */
export async function quoteAddLiquidity(input: QuoteAddLiquidityInput) {
  const selection = {
    positionMint: input.positionMint,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  
  const { quote } = await getSelectedQuoteBundle(
    input.wallet,
    selection,
    input.amount,
    input.resaleFloorBps,
    input.slippageToleranceBps,
  );
  
  // Return only essential quote data, omit internal state
  return {
    wallet: quote.wallet,
    inputMint: quote.inputMint,
    inputKind: quote.inputKind,
    inputDecimals: quote.inputDecimals,
    positionMint: quote.positionMint,
    positionAccount: quote.positionAccount,
    poolId: quote.poolId,
    mintA: quote.mintA,
    mintB: quote.mintB,
    decimalsA: quote.decimalsA,
    decimalsB: quote.decimalsB,
    rangeSide: quote.rangeSide,
    requested: quote.requested,
    spendA: quote.spendA,
    spendB: quote.spendB,
    minOutA: quote.minOutA,
    minOutB: quote.minOutB,
    liquidity: quote.liquidity,
    amountMaxA: quote.amountMaxA,
    amountMaxB: quote.amountMaxB,
    requiredA: quote.requiredA,
    requiredB: quote.requiredB,
    slippageToleranceBps: quote.toleranceBps,
    dustA: quote.dustA,
    dustB: quote.dustB,
    resaleInput: quote.resaleInput,
    minimumResaleInput: quote.minimumResaleInput,
    roundtripCostInput: quote.roundtripCostInput,
    projectedPrice: quote.projectedPrice,
    passesFloor: quote.passesFloor,
    floorBps: quote.floorBps,
    maxImpactBps: quote.maxImpactBps,
    slippageBps: quote.slippageBps,
    routeTouchesTargetPool: quote.routeTouchesTargetPool,
    expiresAt: quote.expiresAt,
    fetchedAt: quote.fetchedAt,
  };
}

/**
 * Prepare an unsigned, simulated transaction for adding liquidity.
 * Returns base64-encoded transaction for the user/agent wallet to sign.
 * 
 * Safety: Full simulation, 1232-byte limit, HMAC permit, re-verification gates.
 * The server never holds private keys. Transaction expires quickly.
 * Failure modes: Simulation failure, size limit, blockhash expiry, state changes.
 */
export async function prepareTransaction(input: PrepareTransactionInput) {
  const selection = {
    positionMint: input.positionMint,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  
  const { summary, transaction } = await buildAndSimulateSelectedZap(
    input.wallet,
    selection,
    input.amount,
    input.resaleFloorBps,
    input.slippageToleranceBps,
  );
  
  const jupiterApiKey = process.env.JUPITER_API_KEY || "";
  const permit = issueSelectedPermit(jupiterApiKey, {
    message: Buffer.from(transaction.message.serialize()).toString("base64"),
    wallet: input.wallet,
    selection,
    requested: summary.quote.requested,
    floorBps: summary.quote.floorBps,
    expiresAt: summary.expiresAt,
    lastValidBlockHeight: summary.lastValidBlockHeight,
    startingLiquidity: summary.startingLiquidity,
    expectedLiquidity: summary.quote.liquidity,
    rangeSide: summary.quote.rangeSide,
    startingBalances: summary.startingBalances,
  });
  
  // Every field submit_signed_transaction needs besides the signed transaction.
  // These values are bound by the permit, so they must be passed back unchanged.
  const submitArgs = {
    permit,
    wallet: input.wallet,
    selection,
    requested: summary.quote.requested,
    expectedLiquidity: summary.quote.liquidity,
    startingLiquidity: summary.startingLiquidity,
    floorBps: summary.quote.floorBps,
    expiresAt: summary.expiresAt,
    lastValidBlockHeight: summary.lastValidBlockHeight,
    rangeSide: summary.quote.rangeSide,
    startingBalances: summary.startingBalances,
  };
  
  const unsignedTransactionBase64 = Buffer.from(transaction.serialize()).toString("base64");
  
  // Create self-contained signed token (no shared storage required)
  const signToken = await createSignToken(
    {
      kind: "add-liquidity",
      wallet: input.wallet,
      unsignedTransaction: unsignedTransactionBase64,
      permit,
      submitArgs,
      expiresAt: summary.expiresAt,
    },
    jupiterApiKey
  );
  
  const signUrl = buildSignUrl(signToken);

  return {
    unsignedTransaction: unsignedTransactionBase64,
    permit,
    submitArgs,
    signToken,
    signUrl,
    summary: {
      simulated: summary.simulated,
      quote: {
        wallet: summary.quote.wallet,
        inputMint: summary.quote.inputMint,
        inputKind: summary.quote.inputKind,
        positionMint: summary.quote.positionMint,
        poolId: summary.quote.poolId,
        rangeSide: summary.quote.rangeSide,
        requested: summary.quote.requested,
        liquidity: summary.quote.liquidity,
        passesFloor: summary.quote.passesFloor,
        floorBps: summary.quote.floorBps,
        slippageToleranceBps: summary.quote.toleranceBps,
        amountMaxA: summary.quote.amountMaxA,
        amountMaxB: summary.quote.amountMaxB,
        expiresAt: summary.quote.expiresAt,
      },
      sizeBytes: summary.sizeBytes,
      unitsConsumed: summary.unitsConsumed,
      feeLamports: summary.feeLamports,
      lastValidBlockHeight: summary.lastValidBlockHeight,
      blockhash: summary.blockhash,
      startingLiquidity: summary.startingLiquidity,
      startingBalances: summary.startingBalances,
      simulatedEndingLiquidity: summary.simulatedEndingLiquidity,
      simulatedInputSpent: summary.simulatedInputSpent,
      simulatedSolDebitLamports: summary.simulatedSolDebitLamports,
      expiresAt: summary.expiresAt,
    },
    instructions: {
      message: "Sign unsignedTransaction with the wallet, then call submit_signed_transaction with { signedTransaction, ...submitArgs }. Do not modify submitArgs; they are bound by the permit. Or open signUrl in a browser with the wallet connected to sign via UI.",
    },
  };
}

/**
 * Get a quote for compounding (harvesting and reinvesting) a position's yield.
 * Includes swap plan, expected liquidity increase, and simulation results.
 * 
 * Safety: Read-only, verifies position eligibility, simulates harvest+swap+add.
 * Failure modes: Ineligible position, third reward token, insufficient yield.
 */
export async function quoteCompound(input: QuoteCompoundInput) {
  const { summary } = await buildAndSimulateCompound(
    input.wallet,
    input.positionMint,
    input.sourceSignatures || [],
  );
  
  // Return only public summary data
  return {
    operation: summary.operation,
    simulated: summary.simulated,
    positionMint: summary.positionMint,
    positionAccount: summary.positionAccount,
    poolId: summary.poolId,
    startingLiquidity: summary.startingLiquidity,
    liquidity: summary.liquidity,
    amountMaxA: summary.amountMaxA,
    amountMaxB: summary.amountMaxB,
    swaps: summary.swaps,
    simulatedHarvest: summary.simulatedHarvest,
    simulatedRewards: summary.simulatedRewards,
    simulatedEndingLiquidity: summary.simulatedEndingLiquidity,
    simulatedDustA: summary.simulatedDustA,
    simulatedDustB: summary.simulatedDustB,
    simulatedSolDebitLamports: summary.simulatedSolDebitLamports,
    maxSolDebitLamports: summary.maxSolDebitLamports,
    feeLamports: summary.feeLamports,
    rentLamports: summary.rentLamports,
    sizeBytes: summary.sizeBytes,
    unitsConsumed: summary.unitsConsumed,
    expiresAt: summary.expiresAt,
    simulatedAt: summary.simulatedAt,
  };
}

/**
 * Prepare an unsigned compound transaction.
 * Returns base64-encoded transaction for signing.
 * 
 * Safety: Same as prepareTransaction, plus isolated yield accounts.
 */
export async function prepareCompoundTransaction(input: QuoteCompoundInput) {
  const { summary, transaction } = await buildAndSimulateCompound(
    input.wallet,
    input.positionMint,
    input.sourceSignatures || [],
  );
  
  const jupiterApiKey = process.env.JUPITER_API_KEY || "";
  const permit = issueCompoundPermit(jupiterApiKey, {
    wallet: input.wallet,
    summary,
    message: Buffer.from(transaction.message.serialize()).toString("base64"),
  });
  
  const unsignedTransactionBase64 = Buffer.from(transaction.serialize()).toString("base64");
  
  // submitArgs for compound includes signedTransaction, permit, wallet, and full summary
  const submitArgs = {
    permit,
    wallet: input.wallet,
    summary,
  };
  
  // Create self-contained signed token (no shared storage required)
  const signToken = await createSignToken(
    {
      kind: "compound",
      wallet: input.wallet,
      unsignedTransaction: unsignedTransactionBase64,
      permit,
      submitArgs,
      expiresAt: summary.expiresAt,
    },
    jupiterApiKey
  );
  
  const signUrl = buildSignUrl(signToken);

  // The permit is an HMAC over the complete summary, so the complete object
  // must be returned and passed back unchanged to submit_compound_transaction.
  return {
    unsignedTransaction: unsignedTransactionBase64,
    permit,
    summary,
    signToken,
    signUrl,
    instructions: {
      message: "Sign unsignedTransaction with the wallet, then call submit_compound_transaction with { signedTransaction, permit, wallet, summary }. Pass summary back exactly as returned; it is bound by the permit. Or open signUrl in a browser with the wallet connected to sign via UI.",
    },
  };
}

/**
 * Submit a signed add-liquidity transaction.
 * Re-verifies all conditions, simulates, then broadcasts.
 * 
 * Safety: HMAC verification, re-read on-chain state, re-simulate, then broadcast.
 * Failure modes: Permit mismatch, state changed, expired, simulation failure.
 */
export async function submitSignedTransaction(input: SubmitSignedTransactionInput) {
  const walletAddress = input.wallet;
  if (
    BigInt(input.requested) <= 0n ||
    BigInt(input.expectedLiquidity) <= 0n ||
    input.expiresAt <= Date.now()
  ) {
    throw new Error("Invalid or expired signed transaction input");
  }
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(input.signedTransaction, "base64")
  );
  
  // Verify permit
  const jupiterApiKey = process.env.JUPITER_API_KEY || "";
  const permitInput = {
    message: Buffer.from(transaction.message.serialize()).toString("base64"),
    wallet: walletAddress,
    selection: input.selection,
    requested: input.requested,
    floorBps: input.floorBps,
    expiresAt: input.expiresAt,
    lastValidBlockHeight: input.lastValidBlockHeight,
    startingLiquidity: input.startingLiquidity,
    expectedLiquidity: input.expectedLiquidity,
    rangeSide: input.rangeSide,
    startingBalances: input.startingBalances,
  };
  
  if (!verifySelectedPermit(jupiterApiKey, permitInput, input.permit)) {
    throw new Error("Transaction content does not match server's simulation permit");
  }
  
  // Verify transaction structure
  const wallet = new PublicKey(walletAddress);
  const walletSignature = transaction.signatures[0];
  if (
    transaction.serialize().length > 1_232 ||
    transaction.message.staticAccountKeys[0]?.toBase58() !== walletAddress ||
    transaction.message.header.numRequiredSignatures !== 1 ||
    transaction.signatures.length !== 1 ||
    !walletSignature ||
    walletSignature.every((byte) => byte === 0)
  ) {
    throw new Error("Payer, signature count, or transaction size mismatch");
  }
  
  // Re-read state and verify
  const connection = rpcConnection();
  const [height, state] = await Promise.all([
    connection.getBlockHeight("confirmed"),
    readSelectedPositionState(walletAddress, input.selection, connection),
  ]);
  
  if (height > input.lastValidBlockHeight) {
    throw new Error("Transaction blockhash expired");
  }
  
  if (
    !state.ownsNft ||
    state.paused ||
    state.frozen ||
    state.transferFee ||
    state.unsupportedExtensions.length ||
    !state.sufficientSol ||
    state.positionMint !== input.selection.positionMint ||
    state.inputMint !== input.selection.inputMint ||
    state.inputKind !== input.selection.inputKind ||
    state.liquidity !== input.startingLiquidity ||
    state.rangeSide !== input.rangeSide ||
    state.balances.input !== input.startingBalances.input ||
    state.balances.a !== input.startingBalances.a ||
    state.balances.b !== input.startingBalances.b
  ) {
    throw new Error("Position, liquidity, or wallet balance has changed since preparation");
  }
  
  // Re-simulate
  await simulateAndVerifySelectedTransaction({
    connection,
    transaction,
    wallet,
    state,
    requested: BigInt(input.requested),
    expectedLiquidity: BigInt(input.expectedLiquidity),
    sigVerify: true,
  });
  
  // Final expiry check
  if (
    Date.now() >= input.expiresAt ||
    (await connection.getBlockHeight("confirmed")) > input.lastValidBlockHeight
  ) {
    throw new Error("Signed transaction expired before broadcast");
  }
  
  // Broadcast
  const expectedSignature = bs58.encode(walletSignature);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  
  if (signature !== expectedSignature) {
    throw new Error("RPC returned transaction signature mismatch");
  }
  
  return { signature };
}

/**
 * Submit a signed compound transaction.
 * Re-verifies permit and summary, then broadcasts.
 * 
 * Safety: Same as submitSignedTransaction.
 */
export async function submitCompoundTransaction(input: SubmitCompoundTransactionInput) {
  try {
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(input.signedTransaction, "base64")
    );

    const jupiterApiKey = process.env.JUPITER_API_KEY || "";
    if (
      !verifyCompoundPermit(
        jupiterApiKey,
        {
          wallet: input.wallet,
          message: Buffer.from(transaction.message.serialize()).toString("base64"),
          summary: input.summary,
        },
        input.permit
      )
    ) {
      throw new Error("Transaction does not match simulated compound authorization");
    }

    if (
      transaction.serialize().length > 1_232 ||
      transaction.message.staticAccountKeys[0]?.toBase58() !== input.wallet ||
      transaction.message.header.numRequiredSignatures !== 1 ||
      transaction.signatures.length !== 1 ||
      !transaction.signatures[0] ||
      transaction.signatures[0].every((byte) => byte === 0)
    ) {
      throw new Error("Compound payer, signature, or transaction size mismatch");
    }

    const summary = input.summary as CompoundSummary;
    if (
      summary.operation !== "compound" ||
      !Number.isSafeInteger(summary.expiresAt) ||
      summary.expiresAt <= Date.now() ||
      !Number.isSafeInteger(summary.lastValidBlockHeight) ||
      summary.lastValidBlockHeight <= 0 ||
      summary.blockhash !== transaction.message.recentBlockhash ||
      summary.state?.wallet !== input.wallet
    ) {
      throw new Error("Compound authorization type, wallet, or expiry mismatch");
    }

    return await sendSignedCompoundTransaction(input.wallet, transaction, summary);
  } catch (error) {
    if (error instanceof CompoundSendError) {
      const message = sanitizePublicError(error.cause ?? error, "Compound transaction broadcast failed");
      throw new Error(error.sent === false ? notSentRetryMessage(message) : message);
    }
    throw new Error(notSentRetryMessage(sanitizePublicError(error, "Compound transaction broadcast failed")));
  }
}

/**
 * List Raydium CLMM pools where both sides are the same underlying RWA
 * (wrapped vs unwrapped / xStock style), with fee/TVL/yield annotations.
 * Filter: Jupiter Tokens API tags (stocks|rwa) + Backed xStocks whitelist.
 *
 * Safety: Read-only; uses public Raydium / Jupiter / xStocks APIs. No wallet or private keys.
 */
export async function listRwaPairs(input: ListRwaPairsInput) {
  const result = await discoverRwaPairs({
    minTvl: input.minTvl,
    maxPages: input.maxPages,
    sortBy: input.sortBy,
  });

  return {
    pairingRule: result.pairingRuleSummary,
    estimatedFeeAprLabel: result.estimatedFeeAprLabel,
    source: result.source,
    fetchedAt: result.fetchedAt,
    scannedPools: result.scannedPools,
    pagesFetched: result.pagesFetched,
    count: result.pairs.length,
    pairs: result.pairs.map((pair) => ({
      poolAddress: pair.poolAddress,
      mintA: pair.mintA,
      mintB: pair.mintB,
      symbolA: pair.symbolA,
      symbolB: pair.symbolB,
      nameA: pair.nameA,
      nameB: pair.nameB,
      baseSymbol: pair.baseSymbol,
      wrappedSymbol: pair.wrappedSymbol,
      plainSymbol: pair.plainSymbol,
      wrapKind: pair.wrapKind,
      relatedness: pair.relatedness,
      qualificationA: pair.qualificationA,
      qualificationB: pair.qualificationB,
      preferredTags: pair.preferredTags,
      jupiterTagsA: pair.jupiterTagsA,
      jupiterTagsB: pair.jupiterTagsB,
      feeRate: pair.feeRate,
      feeTierBps: pair.feeTierBps,
      tvlUsd: pair.tvlUsd,
      volume24hUsd: pair.volume24hUsd,
      fees24hUsd: pair.fees24hUsd,
      raydiumFeeApr24h: pair.raydiumFeeApr24h,
      estimatedFeeAprPct: pair.estimatedFeeAprPct,
      estimatedFeeAprLabel: pair.estimatedFeeAprLabel,
      token2022A: pair.token2022A,
      token2022B: pair.token2022B,
      freezeRiskA: pair.freezeRiskA,
      freezeRiskB: pair.freezeRiskB,
      freezeRisk: pair.freezeRisk,
      openPositionUrl: buildOpenPositionUrl(pair.poolAddress),
      recommendedRanges: OPEN_RANGE_PRESETS,
    })),
  };
}


/**
 * Compute holding-period return / realized fee APR for a Raydium CLMM position NFT
 * from on-chain facts (signatures + Anchor events + current equity). No database.
 *
 * Prefer token-native / token-equivalent (TE) metrics for same-asset RWA wrap pairs
 * (plain/base ticker via current tick mid). USD is optional/secondary.
 *
 * Safety: Read-only. Optional wallet only checks NFT ownership. USD uses current
 * Jupiter Price v3 (Raydium stable-leg fallback) when available (labeled — not historical).
 */
export async function getPositionPerformance(input: GetPositionPerformanceInput) {
  const result = await readPositionPerformance(input.positionMint, {
    wallet: input.wallet,
    maxSignatures: input.maxSignatures,
    skipPricing: input.skipPricing,
  });

  return {
    wallet: result.wallet,
    ownsNft: result.ownsNft,
    positionMint: result.positionMint,
    positionAccount: result.positionAccount,
    poolId: result.poolId,
    mintA: result.mintA,
    mintB: result.mintB,
    decimalsA: result.decimalsA,
    decimalsB: result.decimalsB,
    tickLower: result.tickLower,
    tickUpper: result.tickUpper,
    tickCurrent: result.tickCurrent,
    rangeSide: result.rangeSide,
    liquidity: result.liquidity,
    openedAt: result.openedAt,
    openedAtIso: result.openedAtIso,
    evaluatedAt: result.evaluatedAt,
    evaluatedAtIso: result.evaluatedAtIso,
    signatureCount: result.signatureCount,
    truncated: result.truncated,
    maxSignatures: result.maxSignatures,
    cashflows: result.cashflows,
    metrics: {
      holdingDays: result.metrics.holdingDays,
      depositedRaw: result.metrics.depositedRaw,
      withdrawnPrincipalRaw: result.metrics.withdrawnPrincipalRaw,
      feesCollectedRaw: result.metrics.feesCollectedRaw,
      uncollectedFeesRaw: result.metrics.uncollectedFeesRaw,
      liquidityAmountsRaw: result.metrics.liquidityAmountsRaw,
      currentEquityRaw: result.metrics.currentEquityRaw,
      feesEarnedRaw: result.metrics.feesEarnedRaw,
      pnlRaw: result.metrics.pnlRaw,
      priceUsdA: result.metrics.priceUsdA,
      priceUsdB: result.metrics.priceUsdB,
      depositedUsd: result.metrics.depositedUsd,
      withdrawnPrincipalUsd: result.metrics.withdrawnPrincipalUsd,
      feesCollectedUsd: result.metrics.feesCollectedUsd,
      uncollectedFeesUsd: result.metrics.uncollectedFeesUsd,
      feesEarnedUsd: result.metrics.feesEarnedUsd,
      liquidityUsd: result.metrics.liquidityUsd,
      currentEquityUsd: result.metrics.currentEquityUsd,
      pnlUsd: result.metrics.pnlUsd,
      holdingPeriodReturnPct: result.metrics.holdingPeriodReturnPct,
      annualizedReturnPct: result.metrics.annualizedReturnPct,
      feeOnlyAprPct: result.metrics.feeOnlyAprPct,
    },
    tokenNative: result.tokenNative,
    history: result.history.map((item) => ({
      signature: item.signature,
      blockTime: item.blockTime,
      slot: item.slot,
      events: item.events,
    })),
    pricing: result.pricing,
    method: result.method,
    assumptions: result.assumptions,
    realizedFeeAprSeries: result.realizedFeeAprSeries,
    historyFetch: result.historyFetch,
  };
}

/**
 * Live Blur snapshot for a pool (stats + recent swaps). Read-only.
 * Returns `available: false` when SOLAMI_DATA_API_KEY is unset.
 */
export async function getPoolActivity(input: GetPoolActivityInput) {
  return getPoolActivitySnapshot(input.poolId, { limit: input.limit });
}

/**
 * In/out-of-range status from the latest Blur pool price versus position ticks.
 * Falls back to the on-chain mid when Blur is unavailable. Read-only.
 */
export async function getPositionRangeStatus(input: GetPositionRangeStatusInput) {
  const facts = await readPositionRangeFacts(input.positionMint);
  const poolId = input.poolId ?? facts.poolId;
  const activity = await getPoolActivitySnapshot(poolId, { limit: 8 });
  const blurOriented = blurPriceToBPerA(
    activity.pool?.price ?? null,
    activity.pool?.mint ?? null,
    activity.pool?.quoteMint ?? null,
    facts.mintA,
    facts.mintB,
  );
  const priceBPerA = blurOriented ?? facts.onChainPriceBPerA;
  const status = rangeStatusFromPrice({
    priceBPerA,
    tickLower: facts.tickLower,
    tickUpper: facts.tickUpper,
    decimalsA: facts.decimalsA,
    decimalsB: facts.decimalsB,
    priceSource: blurOriented !== null ? "solami-blur" : "on-chain",
  });
  return {
    wallet: input.wallet ?? null,
    ...facts,
    poolId,
    blurAvailable: activity.available,
    latestTrades: activity.trades.slice(0, 5),
    ...status,
  };
}

function openRangeFromInput(input: QuoteOpenPositionInput) {
  return rangeInputFromFields(input.rangePreset, input.minPrice, input.maxPrice);
}

/**
 * Quote opening a new Raydium CLMM position in a pool (no existing NFT required).
 * Swaps the input asset toward the in-range pool ratio via Jupiter, then sizes liquidity.
 */
export async function quoteOpenPosition(input: QuoteOpenPositionInput) {
  const selection = {
    poolId: input.poolId,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  const { quote } = await getOpenPositionQuoteBundle(
    input.wallet, selection, input.amount, openRangeFromInput(input),
    input.resaleFloorBps, input.slippageToleranceBps,
  );
  return quote;
}

/**
 * Prepare an unsigned open-position transaction. The NFT mint keypair is generated
 * server-side, partial-signs the v0 message, and is discarded — never persisted.
 * The wallet still signs as fee payer. After signing, call submit_open_position.
 */
export async function prepareOpenPosition(input: PrepareOpenPositionInput) {
  const selection = {
    poolId: input.poolId,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  const { summary, transaction } = await buildAndSimulateOpenPosition(
    input.wallet, selection, input.amount, openRangeFromInput(input),
    input.resaleFloorBps, input.slippageToleranceBps,
  );
  const jupiterApiKey = process.env.JUPITER_API_KEY || "";
  const permit = issueOpenPositionPermit(jupiterApiKey, {
    wallet: input.wallet,
    summary,
    message: Buffer.from(transaction.message.serialize()).toString("base64"),
  });
  const unsignedTransactionBase64 = Buffer.from(transaction.serialize()).toString("base64");
  const submitArgs = { permit, wallet: input.wallet, summary };
  const signToken = await createSignToken(
    {
      kind: "open-position",
      wallet: input.wallet,
      unsignedTransaction: unsignedTransactionBase64,
      permit,
      submitArgs,
      expiresAt: summary.expiresAt,
    },
    jupiterApiKey,
  );
  return {
    unsignedTransaction: unsignedTransactionBase64,
    permit,
    summary,
    signToken,
    signUrl: buildSignUrl(signToken),
    instructions: {
      message: "Sign unsignedTransaction with the wallet (keep the existing NFT-mint partial signature), then call submit_open_position with { signedTransaction, permit, wallet, summary }. Pass summary back exactly as returned. Or open signUrl in a browser with the wallet connected.",
    },
  };
}

/**
 * Submit a signed open-position transaction. Dedicated tool (not submit_signed_transaction)
 * because the v0 message has two required signers (wallet + ephemeral NFT mint).
 */
export async function submitOpenPosition(input: SubmitOpenPositionInput) {
  try {
    return await submitOpenPositionFromParts({
      signedTransaction: input.signedTransaction,
      permit: input.permit,
      wallet: input.wallet,
      summary: input.summary as OpenPositionSummary,
    });
  } catch (error) {
    if (error instanceof CompoundSendError) {
      const message = sanitizePublicError(error.cause ?? error, "Open-position transaction broadcast failed");
      throw new Error(error.sent === false ? notSentRetryMessage(message) : message);
    }
    throw new Error(notSentRetryMessage(sanitizePublicError(error, "Open-position transaction broadcast failed")));
  }
}
