import "@/lib/engine-host";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createEphemeralMint, type EphemeralMint } from "@/lib/ephemeral-mint";
import { discoverWallet } from "@sofinance/engine/wallet-discovery";
import { searchSelectedQuoteBundle } from "../lib/selected-quote";
import { submitSelected } from "@/server/transactions/selected-submit";
import { prepareSelected } from "@/server/transactions/selected-prepare";
import { MCP_SELECTED_PREPARE, MCP_OPEN_PREPARE, MCP_WITHDRAW_PREPARE, MCP_SELECTED_SUBMIT, MCP_COMPOUND_PREPARE } from "@/server/transactions/surface-policy";
import { buildAndSimulateCompound } from "@sofinance/engine/compound-atomic";
import { prepareCompound } from "@/server/transactions/compound-prepare";
import { verifySelectedPermit } from "../lib/selected-permit";
import { verifyCompoundPermit } from "../lib/compound-permit";
import { beamAfterSend, noBeamAfterSend } from "@/lib/beam-after-send";
import { sendSignedCompoundTransaction } from "../lib/compound-send";
import { CompoundSendError, notSentRetryMessage, sanitizePublicError } from "../lib/public-error";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import type { CompoundSummary } from "@sofinance/engine/compound-types";
import { getRwaPairs } from "../lib/rwa-store";
import { getPositionPerformance as readPositionPerformance } from "../lib/position-performance";
import { createSignToken } from "../lib/pending-sign-token";
import { buildOpenPositionUrl, buildSignUrl } from "../lib/public-urls";
import { OPEN_RANGE_PRESETS } from "@sofinance/engine/open-range-presets";
import { rangeInputFromFields } from "@sofinance/engine/open-range";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { prepareOpen } from "@/server/transactions/open-prepare";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { submitOpenPositionFromParts } from "../lib/open-send";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";
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
import { isSingleWalletSignedTransaction } from "@sofinance/engine/transaction-limits";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";

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
  
  const { quote } = await searchSelectedQuoteBundle(
    input.wallet,
    selection,
    input.amount,
    input.resaleFloorBps,
    input.slippageToleranceBps,
    { buildTransactions: false, includeResale: false },
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
    suggestedResaleFloorBps: quote.suggestedResaleFloorBps,
    maxAmountForFloor: quote.maxAmountForFloor,
    achievedResaleBps: quote.achievedResaleBps,
    warning: quote.warning || undefined,
    maxImpactBps: quote.maxImpactBps,
    slippageBps: quote.slippageBps,
    routeTouchesTargetPool: quote.routeTouchesTargetPool,
    expiresAt: quote.expiresAt,
    fetchedAt: quote.fetchedAt,
  };
}

// Preserve the original one-key lifetime across the async use-case boundary.
// Capture lazily after build success; never return key material in prepared data.
function capturePrepareSigningSecret() {
  let secret: string | undefined;
  return () => secret ??= getSigningSecret();
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
  const signingSecret = capturePrepareSigningSecret();
  const selection = {
    positionMint: input.positionMint,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  
  const { summary, permit, unsignedTransaction: unsignedTransactionBase64 } = await prepareSelected({
    wallet: input.wallet, selection, amount: input.amount,
    floorBps: input.resaleFloorBps, toleranceBps: input.slippageToleranceBps,
  }, signingSecret, MCP_SELECTED_PREPARE);
  const jupiterApiKey = signingSecret();

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
    feeBps: summary.feeBps,
    feeAmount: summary.feeAmount,
    feeWallet: summary.feeWallet,
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
  const signingSecret = capturePrepareSigningSecret();
  const { summary, permit, unsignedTransaction: unsignedTransactionBase64 } = await prepareCompound({
    wallet: input.wallet, positionMint: input.positionMint, sourceSignatures: input.sourceSignatures || [],
  }, signingSecret, MCP_COMPOUND_PREPARE);
  const jupiterApiKey = signingSecret();

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
  const prepared = input.unsignedTransaction
    ? VersionedTransaction.deserialize(Buffer.from(input.unsignedTransaction, "base64"))
    : transaction;
  if (prepared !== transaction) assertWalletReturnedTransaction(prepared, transaction, walletAddress);

  // Verify permit against the prepared message; the wallet-returned tx is matched semantically.
  const jupiterApiKey = getSigningSecret();
  const permitInput = {
    message: Buffer.from(prepared.message.serialize()).toString("base64"),
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
    !isSingleWalletSignedTransaction(transaction, walletAddress) ||
    !walletSignature
  ) {
    throw new Error("Payer, signature count, or transaction size mismatch");
  }
  
  const signature = await submitSelected({
    transaction, wallet, walletSignature, permitInput,
    prepared: prepared !== transaction ? prepared : undefined,
  }, MCP_SELECTED_SUBMIT);

  // Same as /api/selected-broadcast: no inline Beam wait; landing is status-only via /api/beam-landing.
  const beam = await beamAfterSend(signature, null).catch(() => noBeamAfterSend(signature));
  return { signature, beam: beam.beam, beamLabel: beam.label, beamLandingUrl: beam.beamLandingUrl };
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
    const prepared = input.unsignedTransaction
      ? VersionedTransaction.deserialize(Buffer.from(input.unsignedTransaction, "base64"))
      : transaction;
    if (prepared !== transaction) assertWalletReturnedTransaction(prepared, transaction, input.wallet);

    const jupiterApiKey = getSigningSecret();
    if (
      !verifyCompoundPermit(
        jupiterApiKey,
        {
          wallet: input.wallet,
          message: Buffer.from(prepared.message.serialize()).toString("base64"),
          summary: input.summary,
        },
        input.permit
      )
    ) {
      throw new Error("Transaction does not match simulated compound authorization");
    }

    if (
      !isSingleWalletSignedTransaction(transaction, input.wallet)
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

    return await sendSignedCompoundTransaction(
      input.wallet, transaction, summary, prepared !== transaction ? prepared : undefined,
    );
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
 * (wrapped vs unwrapped / xStock style), plus the curated USDC/USDT pool,
 * with fee/TVL/yield annotations.
 * Filter: Jupiter Tokens API tags (stocks|rwa) + Backed xStocks whitelist + curated CLMM allowlist.
 *
 * Safety: Read-only; uses public Raydium / Jupiter / xStocks APIs. No wallet or private keys.
 */
export async function listRwaPairs(input: ListRwaPairsInput) {
  const result = await getRwaPairs({ minTvl: input.minTvl, maxPages: input.maxPages, sortBy: input.sortBy });

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
 * from position history (persisted when enabled) and current on-chain equity.
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
    refreshHistory: input.refreshHistory,
    historyAfterSignatures: input.historyAfterSignatures,
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
    timings: result.timings,
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
  assertSolInputAllowed(selection);
  const { quote } = await getOpenPositionQuoteBundle(
    input.wallet, selection, input.amount, openRangeFromInput(input),
    input.resaleFloorBps, input.slippageToleranceBps,
  );
  return quote;
}

/**
 * MCP-ONLY fallback: partial-sign with an ephemeral mint so `/app/sign/<token>`
 * can broadcast without a browser-held mint secret. HTTP `/api/open-prepare`
 * never takes this path. Phantom may still warn because the sign page then
 * presents a pre-signed extra signer. Prefer passing `nftMint` and signing the
 * mint after the wallet (Phantom multi-signer recipe).
 */
function mcpPartialSignOpenMint(unsignedTransactionBase64: string, mint: EphemeralMint): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTransactionBase64, "base64"));
  try {
    tx.sign([mint]);
  } finally {
    mint.dispose();
  }
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * Prepare an unsigned open-position transaction. Prefer `nftMint` from an agent-held
 * Keypair: the server never signs. After the wallet signs, add the mint signature
 * to the transaction the wallet returns, zero the secret, then submit_open_position.
 */
export async function prepareOpenPosition(input: PrepareOpenPositionInput) {
  const signingSecret = capturePrepareSigningSecret();
  const selection = {
    poolId: input.poolId,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  // MCP-ONLY: generate and partial-sign when the agent omits nftMint (signUrl
  // cannot hold the mint secret). Agents that can sign should pass nftMint.
  const mint = input.nftMint ? undefined : createEphemeralMint();
  try {
    const { summary, permit, unsignedTransaction } = await prepareOpen({
      wallet: input.wallet, selection, amount: input.amount, range: openRangeFromInput(input),
      floorBps: input.resaleFloorBps, toleranceBps: input.slippageToleranceBps,
      nftMint: input.nftMint ?? mint!.publicKey.toBase58(),
    }, signingSecret, MCP_OPEN_PREPARE);
    const unsignedTransactionBase64 = mint ? mcpPartialSignOpenMint(unsignedTransaction, mint) : unsignedTransaction;
    const jupiterApiKey = signingSecret();
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
        message: mint
          ? "MCP-ONLY fallback: this transaction is partial-signed by an ephemeral NFT mint so /app/sign can submit without a browser-held mint secret. Phantom may still warn. Prefer passing nftMint, signing the wallet first, then adding the mint signature on the wallet-returned tx before submit_open_position."
          : "Sign unsignedTransaction with the wallet FIRST, then add the NFT mint signature to the transaction the wallet returns without modifying the message, then call submit_open_position with { signedTransaction, permit, wallet, summary }. Pass summary back exactly as returned. signUrl cannot add the mint signature; use programmatic submit when you generated nftMint.",
      },
    };
  } finally {
    mint?.dispose();
  }
}

/**
 * Submit a signed open-position transaction. Dedicated tool (not submit_signed_transaction)
 * because the v0 message has two required signers (wallet + ephemeral NFT mint).
 */
export async function submitOpenPosition(input: SubmitOpenPositionInput) {
  try {
    return await submitOpenPositionFromParts({
      signedTransaction: input.signedTransaction,
      unsignedTransaction: input.unsignedTransaction,
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

export async function prepareWithdraw(input: import("@sofinance/engine/withdraw/types").WithdrawPrepareRequest) {
 const {prepareWithdrawal}=await import("@/server/transactions/withdraw-prepare");
 const prepared=await prepareWithdrawal(input, MCP_WITHDRAW_PREPARE);
 const submitArgs={wallet:input.wallet,permit:prepared.permit,summary:prepared.summary,confirmHighImpact:input.confirmHighImpact===true};
 const signToken=await createSignToken({kind:"withdraw",wallet:input.wallet,unsignedTransaction:prepared.unsignedTransaction,permit:prepared.permit,submitArgs,expiresAt:prepared.summary.expiresAt},getSigningSecret());
 return {...prepared,submitArgs,signToken,signUrl:buildSignUrl(signToken)};
}
export async function submitWithdrawTransaction(input: Parameters<typeof import("../lib/withdraw/send").submitWithdraw>[0]) {
 const {submitWithdraw}=await import("../lib/withdraw/send");
 return submitWithdraw(input);
}
