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
import type {
  ListPositionsInput,
  QuoteAddLiquidityInput,
  PrepareTransactionInput,
  QuoteCompoundInput,
  SubmitSignedTransactionInput,
  SubmitCompoundTransactionInput,
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
  
  return {
    unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    permit,
    summary: {
      simulated: summary.simulated,
      quote: {
        wallet: summary.quote.wallet,
        inputMint: summary.quote.inputMint,
        inputKind: summary.quote.inputKind,
        positionMint: summary.quote.positionMint,
        poolId: summary.quote.poolId,
        requested: summary.quote.requested,
        liquidity: summary.quote.liquidity,
        passesFloor: summary.quote.passesFloor,
        floorBps: summary.quote.floorBps,
        expiresAt: summary.quote.expiresAt,
      },
      sizeBytes: summary.sizeBytes,
      unitsConsumed: summary.unitsConsumed,
      feeLamports: summary.feeLamports,
      lastValidBlockHeight: summary.lastValidBlockHeight,
      blockhash: summary.blockhash,
      startingLiquidity: summary.startingLiquidity,
      simulatedEndingLiquidity: summary.simulatedEndingLiquidity,
      simulatedInputSpent: summary.simulatedInputSpent,
      simulatedSolDebitLamports: summary.simulatedSolDebitLamports,
      expiresAt: summary.expiresAt,
    },
    instructions: {
      message: "Sign the unsignedTransaction with your wallet, then call submit_signed_transaction with the signed transaction, permit, and all required parameters.",
      requiredForSubmit: [
        "signedTransaction",
        "permit",
        "wallet",
        "selection (positionMint, inputMint, inputKind)",
        "requested",
        "expectedLiquidity",
        "startingLiquidity",
        "floorBps",
        "expiresAt",
        "lastValidBlockHeight",
        "rangeSide",
        "startingBalances (input, a, b)",
      ],
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
  
  return {
    unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    permit,
    summary: {
      operation: summary.operation,
      simulated: summary.simulated,
      positionMint: summary.positionMint,
      liquidity: summary.liquidity,
      sizeBytes: summary.sizeBytes,
      feeLamports: summary.feeLamports,
      expiresAt: summary.expiresAt,
    },
    instructions: {
      message: "Sign the unsignedTransaction with your wallet, then call submit_compound_transaction with the signed transaction, permit, wallet, and complete summary object.",
      requiredForSubmit: [
        "signedTransaction",
        "permit",
        "wallet",
        "summary (complete object from this response)",
      ],
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
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(input.signedTransaction, "base64")
  );
  
  // Verify permit
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
  
  // Basic checks
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
  
  // Expiry check
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = input.summary as any;
  if (
    !Number.isSafeInteger(summary.expiresAt) ||
    summary.expiresAt <= Date.now() ||
    !Number.isSafeInteger(summary.lastValidBlockHeight) ||
    summary.lastValidBlockHeight <= 0
  ) {
    throw new Error("Compound authorization expired");
  }
  
  const connection = rpcConnection();
  const height = await connection.getBlockHeight("confirmed");
  
  if (height > summary.lastValidBlockHeight) {
    throw new Error("Transaction blockhash expired");
  }
  
  // Broadcast
  const walletSignature = transaction.signatures[0]!;
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
