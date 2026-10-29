import "@/lib/engine-host";
import "server-only";

import {
  ACCOUNT_SIZE, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection, type TransactionInstruction,
} from "@solana/web3.js";
import { decodeLbPair, meteoraBinArrayAddress, meteoraBinArrayIndexesForRange, type LbPairState } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_PROGRAM_ID, type MeteoraAllowlistedPool } from "@sofinance/engine/protocols/meteora/constants";
import { decodeMeteoraPosition, isMeteoraPositionAccount, meteoraPositionLiquidity, METEORA_POSITION_BASE_LEN } from "@sofinance/engine/protocols/meteora/position";
import {
  assertMeteoraOpenRange, meteoraAddLiquidityByStrategy2Instruction, meteoraClosePosition2Instruction, meteoraInitializePositionInstruction,
  meteoraMaxActiveBinSlippage, meteoraSpotSplit,
} from "@sofinance/engine/protocols/meteora/open";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT, SLIPPAGE_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { assertNoDirectFeeWalletInstructions, readSwapFeeConfig, type SwapFeeConfig } from "@sofinance/engine/swap/fee";
import { depositFeePlan, feeSwapLeg } from "@sofinance/engine/swap/leg";
import { swapRouteInstructions } from "@sofinance/engine/swap/instructions";
import type { BuildRoute } from "@sofinance/engine/swap/jupiter";
import { JUPITER_ROUTE_ATTEMPTS, isTxOversizeError, type JupiterRouteConstraints } from "@sofinance/engine/jupiter-route-retry";
import { assertOpenTransactionSize, compactAtaInstructions, compileCompactOpenTransaction, openLookupTableReader, versionedTransactionSize } from "@sofinance/engine/open-transaction";
import { ATOMIC_COMPUTE_UNIT_LIMIT, measuredComputeUnitLimit } from "@sofinance/engine/transaction-limits";

/**
 * Meteora DLMM open flow (design PR12): BUILD + SIMULATE only. Two transactions:
 *
 * - 1/2 "setup": `initialize_position` (fresh position keypair supplied and later signed by the client) plus
 *   idempotent creation of the wallet's own token X / Y ATAs. Creates only the user's own accounts; the user
 *   pays the position rent (refunded to the user by `close_position2`). No swap, no fee.
 * - 2/2 "deposit": Jupiter swap legs for the part of the input that is not already a pool token, each with the
 *   SoFinance fee as Jupiter `platformFeeBps` in the input mint paid into the fee wallet's pre-existing ATA
 *   (`requireInputFeeAccount` via `buildRoute`; missing ⇒ `SwapFeeAccountMissingError`, nothing built), then
 *   `add_liquidity_by_strategy2` (Spot). The kept portion is not charged.
 *
 * Both transactions run `assertNoDirectFeeWalletInstructions`: no transfer to, ATA creation for, or token
 * instruction referencing the fee wallet. Native SOL input is rejected (its wrap is a bare SystemProgram
 * transfer, and the SOL-input design gate is open). v1 only opens ranges whose bin arrays already exist.
 * Nothing here signs or sends.
 */

export const METEORA_OPEN_PROTOCOL = "meteora-dlmm" as const;
/** Default token-account rent fallback (165 bytes) if the RPC cannot price it. */
const TOKEN_ACCOUNT_RENT_FALLBACK = 2_039_280;
/** Lamports per signature (base fee). */
const SIGNATURE_LAMPORTS = 5_000;
/** Allowance for intermediate token accounts a Jupiter route may create in 2/2 (two token accounts). */
export const DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE = 2 * TOKEN_ACCOUNT_RENT_FALLBACK;

export class MeteoraOpenBlockedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MeteoraOpenBlockedError";
  }
}

export type MeteoraOpenParams = {
  wallet: string;
  poolId: string;
  inputMint: string;
  /** Input amount in the input mint's smallest units. */
  amount: bigint;
  lowerBinId: number;
  upperBinId: number;
  /** Position account (fresh keypair public key, generated and kept by the client). */
  position: string;
};

export type MeteoraOpenDeps = {
  connection: Connection;
  feeConfig?: () => SwapFeeConfig;
  /** Jupiter leg builder (tests inject a fake). */
  swapLeg?: typeof feeSwapLeg;
  now?: () => number;
};

type Leg = Awaited<ReturnType<typeof feeSwapLeg>>;

export type MeteoraLegPlan = {
  side: "x" | "y";
  inputMint: string;
  outputMint: string;
  spend: string;
  feeBps: number;
  /** Fee in input units, taken by Jupiter from `spend` (platformFeeBps). 0 for a kept portion. */
  feeAmount: string;
  /** Guaranteed output (slippage floor) deposited into the position. */
  minOut: string;
  swapped: boolean;
};

export type MeteoraSimulation = { ok: true; unitsConsumed: number; computeUnitLimit: number; logsTail: string[]; solDebitLamports: string };

export type MeteoraRentEstimate = {
  /** Position account rent; refunded to the wallet by close_position2. */
  positionLamports: string;
  /** Wallet's own token X / Y ATAs created in 1/2 (kept by the wallet). */
  tokenAccountLamports: string;
  /** Uninitialized bin arrays: v1 never creates them (range blocked instead), so always 0. */
  binArrayLamports: "0";
  networkFeeLamports: string;
  totalLamports: string;
  refundableLamports: string;
};

export type MeteoraMinimumCheck = { walletLamports: string; requiredLamports: string; reserveLamports: string; ok: boolean };

function spec(poolId: string): MeteoraAllowlistedPool {
  const found = METEORA_ALLOWLISTED_POOLS.find((pool) => pool.poolAddress === poolId);
  if (!found) throw new MeteoraOpenBlockedError("Pool is not on the Meteora allowlist", "pool_not_allowlisted");
  return found;
}

function assertInputMint(pool: MeteoraAllowlistedPool, inputMint: string) {
  if (inputMint === NATIVE_SOL_MINT) {
    throw new MeteoraOpenBlockedError("SOL input is not available for Meteora yet. Please use USDC, cbBTC or WBTC.", "sol_input_unavailable");
  }
  if (![pool.mintX, pool.mintY, USDC_MINT].includes(inputMint)) {
    throw new MeteoraOpenBlockedError("Meteora v1 accepts only USDC or a pool token as input", "input_not_supported");
  }
}

function insufficientInputMessage(params: MeteoraOpenParams, state: Pick<MeteoraOpenState, "pool" | "inputBalance">) {
  const [symbol, decimals] = params.inputMint === USDC_MINT ? ["USDC", 6] : params.inputMint === state.pool.mintX ? [state.pool.wrappedSymbol, 8] : [state.pool.plainSymbol, 8];
  const units = (raw: bigint) => (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals });
  return `Not enough ${symbol}: add about ${units(params.amount - state.inputBalance)} ${symbol} or lower the amount (you have ${units(state.inputBalance)} ${symbol}).`;
}

export function assertMeteoraParams(params: MeteoraOpenParams) {
  for (const value of [params.wallet, params.poolId, params.inputMint, params.position]) new PublicKey(value);
  if (params.position === params.wallet) throw new Error("Position account must be a fresh keypair");
  if (params.amount <= 0n) throw new Error("Amount must be greater than zero");
  const pool = spec(params.poolId);
  assertInputMint(pool, params.inputMint);
  try {
    assertMeteoraOpenRange(params.lowerBinId, params.upperBinId);
  } catch (error) {
    throw new MeteoraOpenBlockedError(error instanceof Error ? error.message : "Invalid range", "range_not_supported");
  }
  return pool;
}

function tokenBalance(info: AccountInfo<Buffer> | null, address: PublicKey, owner: PublicKey, mint: string) {
  if (!info) return { exists: false, amount: 0n };
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("Token account program mismatch");
  const account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  if (!account.owner.equals(owner) || account.mint.toBase58() !== mint) throw new Error("Token account owner or mint mismatch");
  if (account.isFrozen) throw new MeteoraOpenBlockedError("A wallet token account for this pool is frozen", "token_account_frozen");
  return { exists: true, amount: account.amount };
}

export type MeteoraOpenState = {
  pool: MeteoraAllowlistedPool;
  lbPair: LbPairState;
  binArrays: string[];
  walletLamports: bigint;
  ataX: PublicKey; ataY: PublicKey; inputAta: PublicKey;
  ataXExists: boolean; ataYExists: boolean;
  inputBalance: bigint;
  positionInfo: AccountInfo<Buffer> | null;
  slot: number;
};

/** One batched read: pool, every bin array of the range, wallet SOL, wallet ATAs, input ATA and the position account. */
export async function readMeteoraOpenState(connection: Connection, params: MeteoraOpenParams): Promise<MeteoraOpenState> {
  const pool = assertMeteoraParams(params);
  const wallet = new PublicKey(params.wallet);
  if (pool.tokenProgramX !== TOKEN_PROGRAM_ID.toBase58() || pool.tokenProgramY !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new MeteoraOpenBlockedError("Meteora v1 supports SPL Token pools only", "token_program_not_supported");
  }
  const ataX = getAssociatedTokenAddressSync(new PublicKey(pool.mintX), wallet, false, TOKEN_PROGRAM_ID);
  const ataY = getAssociatedTokenAddressSync(new PublicKey(pool.mintY), wallet, false, TOKEN_PROGRAM_ID);
  const inputAta = getAssociatedTokenAddressSync(new PublicKey(params.inputMint), wallet, false, TOKEN_PROGRAM_ID);
  const binArrays = meteoraBinArrayIndexesForRange(params.lowerBinId, params.upperBinId).map((index) => meteoraBinArrayAddress(params.poolId, index));
  const keys = [new PublicKey(params.poolId), wallet, ataX, ataY, inputAta, new PublicKey(params.position), ...binArrays.map((a) => new PublicKey(a))];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys, "confirmed");
  const [lbPairInfo, walletInfo, ataXInfo, ataYInfo, inputInfo, positionInfo, ...binInfos] = value;
  if (!lbPairInfo || lbPairInfo.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID) throw new Error("Meteora pool account not found");
  const lbPair = decodeLbPair(lbPairInfo.data);
  if (lbPair.tokenXMint !== pool.mintX || lbPair.tokenYMint !== pool.mintY || lbPair.binStep !== pool.binStep) {
    throw new MeteoraOpenBlockedError("Pool state does not match the allowlist", "pool_mismatch");
  }
  if (lbPair.status !== 0) throw new MeteoraOpenBlockedError("Meteora pool is disabled", "pool_disabled");
  if (lbPair.tokenProgramFlagX !== 0 || lbPair.tokenProgramFlagY !== 0) {
    throw new MeteoraOpenBlockedError("Meteora v1 supports SPL Token pools only", "token_program_not_supported");
  }
  const missing = binArrays.filter((_, i) => !binInfos[i] || binInfos[i]!.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID);
  if (missing.length) {
    throw new MeteoraOpenBlockedError(
      "This range needs a new Meteora bin array (about 0.075 SOL each, not refundable). SoFinance v1 only opens ranges inside existing bin arrays; please choose a narrower range near the current price.",
      "bin_array_missing",
    );
  }
  const x = tokenBalance(ataXInfo ?? null, ataX, wallet, pool.mintX);
  const y = tokenBalance(ataYInfo ?? null, ataY, wallet, pool.mintY);
  const input = tokenBalance(inputInfo ?? null, inputAta, wallet, params.inputMint);
  return {
    pool, lbPair, binArrays, walletLamports: BigInt(walletInfo?.lamports ?? 0), ataX, ataY, inputAta,
    ataXExists: x.exists, ataYExists: y.exists, inputBalance: input.amount, positionInfo: positionInfo ?? null, slot: context.slot,
  };
}

/** Value split of a Spot deposit, then one Jupiter leg (with the fee) per side that is not already the input mint. */
export async function planMeteoraLegs(params: MeteoraOpenParams, state: Pick<MeteoraOpenState, "pool" | "lbPair">, deps: Pick<MeteoraOpenDeps, "feeConfig" | "swapLeg">,
  options: { build: boolean; constraints?: JupiterRouteConstraints }) {
  const config = (deps.feeConfig ?? readSwapFeeConfig)();
  const plan = depositFeePlan(params.amount, config);
  const split = meteoraSpotSplit(params.amount, state.lbPair.activeId, params.lowerBinId, params.upperBinId);
  const swapLeg = deps.swapLeg ?? feeSwapLeg;
  const sides = [
    { side: "x" as const, mint: state.pool.mintX, spend: split.x },
    { side: "y" as const, mint: state.pool.mintY, spend: split.y },
  ].filter((item) => item.spend > 0n);
  const legs = await Promise.all(sides.map(async (item): Promise<{ plan: MeteoraLegPlan; leg: Leg | null }> => {
    if (item.mint === params.inputMint) {
      return { leg: null, plan: { side: item.side, inputMint: params.inputMint, outputMint: item.mint, spend: item.spend.toString(), feeBps: 0, feeAmount: "0", minOut: item.spend.toString(), swapped: false } };
    }
    const leg = await swapLeg({
      wallet: params.wallet, inputMint: params.inputMint, outputMint: item.mint, spend: item.spend, feeBps: plan.legBps,
      inputFee: plan.inputFee, build: options.build, constraints: options.constraints,
    });
    if (plan.legBps > 0 && (!leg.feeInRoute || leg.feeAmount <= 0n)) throw new Error("Protocol fee is not collected inside the Jupiter swap");
    return { leg, plan: { side: item.side, inputMint: params.inputMint, outputMint: item.mint, spend: item.spend.toString(), feeBps: plan.legBps, feeAmount: leg.feeAmount.toString(), minOut: leg.minOut.toString(), swapped: true } };
  }));
  const amountX = legs.filter((l) => l.plan.side === "x").reduce((sum, l) => sum + BigInt(l.plan.minOut), 0n);
  const amountY = legs.filter((l) => l.plan.side === "y").reduce((sum, l) => sum + BigInt(l.plan.minOut), 0n);
  const routes = legs.flatMap((l) => (l.leg?.route ? [l.leg.route as BuildRoute] : []));
  return { config, legs: legs.map((l) => l.plan), routes, amountX, amountY };
}

async function rentFor(connection: Connection, space: number, fallback: number) {
  try { return BigInt(await connection.getMinimumBalanceForRentExemption(space, "confirmed")); } catch { return BigInt(fallback); }
}

function compileV0(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[]) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
}

function cuLimit(units: number) {
  return ComputeBudgetProgram.setComputeUnitLimit({ units });
}

async function simulate(connection: Connection, transaction: VersionedTransaction, addresses: PublicKey[], minContextSlot: number) {
  const result = await connection.simulateTransaction(transaction, {
    sigVerify: false, commitment: "confirmed", minContextSlot, accounts: { encoding: "base64", addresses: addresses.map((a) => a.toBase58()) },
  });
  if (result.value.err) {
    throw new Error(`Meteora simulation failed: ${JSON.stringify(result.value.err)}; ${result.value.logs?.slice(-6).join(" | ") || "no logs"}`);
  }
  return result.value;
}

function accountData(account: { data: string[] } | null | undefined) {
  const data = account?.data?.[0];
  return data ? Buffer.from(data, "base64") : null;
}

export function meteoraSetupInstructions(params: MeteoraOpenParams, state: Pick<MeteoraOpenState, "pool" | "ataX" | "ataY" | "ataXExists" | "ataYExists">, units = ATOMIC_COMPUTE_UNIT_LIMIT) {
  const wallet = new PublicKey(params.wallet);
  return [
    cuLimit(units),
    ...(state.ataXExists ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, state.ataX, wallet, new PublicKey(state.pool.mintX), TOKEN_PROGRAM_ID)]),
    ...(state.ataYExists ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, state.ataY, wallet, new PublicKey(state.pool.mintY), TOKEN_PROGRAM_ID)]),
    meteoraInitializePositionInstruction({
      payer: wallet, position: new PublicKey(params.position), lbPair: new PublicKey(params.poolId), owner: wallet,
      lowerBinId: params.lowerBinId, width: params.upperBinId - params.lowerBinId + 1,
    }),
  ];
}

export function meteoraDepositAddInstruction(params: MeteoraOpenParams, state: Pick<MeteoraOpenState, "pool" | "lbPair" | "ataX" | "ataY">, amountX: bigint, amountY: bigint) {
  const wallet = new PublicKey(params.wallet);
  return meteoraAddLiquidityByStrategy2Instruction({
    position: new PublicKey(params.position), lbPair: new PublicKey(params.poolId), sender: wallet,
    userTokenX: state.ataX, userTokenY: state.ataY, reserveX: new PublicKey(state.lbPair.reserveX), reserveY: new PublicKey(state.lbPair.reserveY),
    tokenXMint: new PublicKey(state.pool.mintX), tokenYMint: new PublicKey(state.pool.mintY), tokenXProgram: TOKEN_PROGRAM_ID, tokenYProgram: TOKEN_PROGRAM_ID,
    amountX, amountY, activeId: state.lbPair.activeId, maxActiveBinSlippage: meteoraMaxActiveBinSlippage(SLIPPAGE_BPS, state.lbPair.binStep),
    minBinId: params.lowerBinId, maxBinId: params.upperBinId,
  });
}

export class MeteoraSystemTransferError extends Error {
  constructor() {
    super("Meteora transactions must not contain a bare SystemProgram transfer");
    this.name = "MeteoraSystemTransferError";
  }
}

/**
 * Guard every Meteora transaction: no direct fee-wallet instruction of any kind (#219: no transfer to it,
 * no fee-wallet ATA created) and no bare top-level SystemProgram transfer (Phantom flags those).
 */
export function assertMeteoraFeeRule(instructions: TransactionInstruction[], config: SwapFeeConfig) {
  assertNoDirectFeeWalletInstructions(instructions, config.wallet);
  for (const ix of instructions) {
    if (ix.programId.equals(SystemProgram.programId) && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2) throw new MeteoraSystemTransferError();
  }
}

/** Assembles 2/2. `compactAtas`: drop ATA creates for accounts that already exist (only after 1/2 has landed). */
export async function compileMeteoraDeposit(connection: Connection, params: MeteoraOpenParams, state: MeteoraOpenState, deps: MeteoraOpenDeps, blockhash: string, options: { compactAtas: boolean }) {
  let lastError: unknown;
  const lookupTables = openLookupTableReader(connection);
  for (const constraints of JUPITER_ROUTE_ATTEMPTS) {
    const legs = await planMeteoraLegs(params, state, deps, { build: true, constraints });
    const wallet = new PublicKey(params.wallet);
    const swapIxs = swapRouteInstructions(legs.routes, wallet);
    const body = [...swapIxs, meteoraDepositAddInstruction(params, state, legs.amountX, legs.amountY)];
    const instructions = options.compactAtas ? await compactAtaInstructions(connection, [cuLimit(ATOMIC_COMPUTE_UNIT_LIMIT), ...body]) : [cuLimit(ATOMIC_COMPUTE_UNIT_LIMIT), ...body];
    assertMeteoraFeeRule(instructions, legs.config);
    const tables = await lookupTables(legs.routes.flatMap((route) => Object.keys(route.addressesByLookupTableAddress ?? {}).map((key) => new PublicKey(key))));
    const compiled = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: blockhash, instructions }, tables);
    try {
      assertOpenTransactionSize(compiled.transaction);
      return { ...legs, instructions, tables: compiled.tables, transaction: compiled.transaction };
    } catch (error) {
      lastError = error;
      if (!isTxOversizeError(error) || legs.routes.length === 0) throw error;
    }
  }
  throw lastError;
}

function minimumCheck(walletLamports: bigint, required: bigint): MeteoraMinimumCheck {
  return { walletLamports: walletLamports.toString(), requiredLamports: required.toString(), reserveLamports: String(MIN_SOL_LAMPORTS), ok: walletLamports >= required };
}

export type MeteoraSetupResult = {
  protocol: typeof METEORA_OPEN_PROTOCOL; step: 1; of: 2; wallet: string; poolId: string; position: string;
  lowerBinId: number; upperBinId: number; activeId: number; inputMint: string; amount: string;
  transaction: string; blockhash: string; lastValidBlockHeight: number; sizeBytes: number;
  simulation: MeteoraSimulation; rent: MeteoraRentEstimate; minimum: MeteoraMinimumCheck;
  fee: { bps: number; chargedOn: "swapped portion only"; collection: "Jupiter platformFeeBps into the fee wallet's pre-existing input-mint ATA" };
  legs: MeteoraLegPlan[]; amountX: string; amountY: string;
  /** 2/2 was assembled now (not simulated: the position does not exist until 1/2 lands) to check it fits. */
  depositDraft: { sizeBytes: number };
  createsOnlyWalletOwnedAccounts: true;
};

/** 1/2: initialize_position + the wallet's own ATAs. Blocks on the minimum check before simulating. */
export async function prepareMeteoraSetup(params: MeteoraOpenParams, deps: MeteoraOpenDeps): Promise<MeteoraSetupResult> {
  const { connection } = deps;
  const state = await readMeteoraOpenState(connection, params);
  if (state.positionInfo) throw new Error("Position account already exists; generate a fresh position keypair");
  if (state.inputBalance < params.amount) throw new MeteoraOpenBlockedError(insufficientInputMessage(params, state), "input_balance_insufficient");
  const wallet = new PublicKey(params.wallet);
  const [positionRent, tokenRent, latest] = await Promise.all([
    rentFor(connection, METEORA_POSITION_BASE_LEN, 57_406_080),
    rentFor(connection, ACCOUNT_SIZE, TOKEN_ACCOUNT_RENT_FALLBACK),
    connection.getLatestBlockhash("confirmed"),
  ]);
  const ataCount = BigInt(Number(!state.ataXExists) + Number(!state.ataYExists));
  // 2/2 first (fee guard, Jupiter quotes, size): never ask the user to pay position rent for an open that cannot complete.
  const draft = await compileMeteoraDeposit(connection, params, state, deps, latest.blockhash, { compactAtas: false });
  const draftSize = versionedTransactionSize(draft.transaction);
  const networkFee = BigInt(3 * SIGNATURE_LAMPORTS); // 1/2: wallet + position signatures; 2/2: wallet
  const rentTotal = positionRent + tokenRent * ataCount;
  const required = BigInt(MIN_SOL_LAMPORTS) + rentTotal + networkFee + BigInt(DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE);
  const minimum = minimumCheck(state.walletLamports, required);
  const rent: MeteoraRentEstimate = {
    positionLamports: positionRent.toString(), tokenAccountLamports: (tokenRent * ataCount).toString(), binArrayLamports: "0",
    networkFeeLamports: networkFee.toString(), totalLamports: (rentTotal + networkFee).toString(), refundableLamports: positionRent.toString(),
  };
  if (!minimum.ok) {
    throw Object.assign(new MeteoraOpenBlockedError(
      `Not enough SOL: add about ${(Math.ceil(Number(required - state.walletLamports) / 1e5) / 1e4).toFixed(4)} SOL. This open needs about ${(Number(required) / 1e9).toFixed(4)} SOL (position rent ${(Number(positionRent) / 1e9).toFixed(4)} SOL, refunded when you close the position, plus token accounts, network fees and a ${MIN_SOL_LAMPORTS / 1e9} SOL reserve); your wallet has ${(Number(state.walletLamports) / 1e9).toFixed(4)} SOL.`,
      "sol_insufficient",
    ), { rent, minimum });
  }
  const instructions = meteoraSetupInstructions(params, state);
  assertMeteoraFeeRule(instructions, draft.config);
  const probe = compileV0(wallet, latest.blockhash, instructions);
  const sim = await simulate(connection, probe, [new PublicKey(params.position), wallet], state.slot);
  const positionAfter = accountData(sim.accounts?.[0]);
  if (!positionAfter || sim.accounts?.[0]?.owner !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(positionAfter)) {
    throw new Error("Simulation did not create the Meteora position account");
  }
  const decoded = decodeMeteoraPosition(positionAfter);
  if (decoded.owner !== params.wallet || decoded.lbPair !== params.poolId || decoded.lowerBinId !== params.lowerBinId || decoded.upperBinId !== params.upperBinId) {
    throw new Error("Simulated position does not match the requested owner, pool or range");
  }
  const solAfter = BigInt(sim.accounts?.[1]?.lamports ?? 0);
  const solDebit = state.walletLamports - solAfter;
  if (solDebit > rentTotal + networkFee) throw new Error("1/2 simulation debits more SOL than the estimated rent and fees");
  const units = measuredComputeUnitLimit(sim.unitsConsumed ?? 0);
  const transaction = compileV0(wallet, latest.blockhash, meteoraSetupInstructions(params, state, units));
  const sizeBytes = assertOpenTransactionSize(transaction);
  return {
    protocol: METEORA_OPEN_PROTOCOL, step: 1, of: 2, wallet: params.wallet, poolId: params.poolId, position: params.position,
    lowerBinId: params.lowerBinId, upperBinId: params.upperBinId, activeId: state.lbPair.activeId, inputMint: params.inputMint, amount: params.amount.toString(),
    transaction: Buffer.from(transaction.serialize()).toString("base64"), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, sizeBytes,
    simulation: { ok: true, unitsConsumed: sim.unitsConsumed ?? 0, computeUnitLimit: units, logsTail: (sim.logs ?? []).slice(-4), solDebitLamports: solDebit.toString() },
    rent, minimum,
    fee: { bps: draft.config.bps, chargedOn: "swapped portion only", collection: "Jupiter platformFeeBps into the fee wallet's pre-existing input-mint ATA" },
    legs: draft.legs, amountX: draft.amountX.toString(), amountY: draft.amountY.toString(),
    depositDraft: { sizeBytes: draftSize }, createsOnlyWalletOwnedAccounts: true,
  };
}

export type MeteoraDepositResult = Omit<MeteoraSetupResult, "step" | "rent" | "depositDraft" | "createsOnlyWalletOwnedAccounts" | "minimum"> & {
  step: 2; positionLiquidityAfter: string; inputSpend: string;
};

/** Reads and checks the position created by 1/2: owned by the wallet, in the pool, the requested range, still empty. */
function assertEmptyOwnedPosition(info: AccountInfo<Buffer> | null, params: Pick<MeteoraOpenParams, "wallet" | "poolId" | "lowerBinId" | "upperBinId">) {
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) {
    throw new MeteoraOpenBlockedError("Position account not found yet; wait for step 1/2 to confirm", "position_missing");
  }
  const position = decodeMeteoraPosition(info.data);
  if (position.owner !== params.wallet || position.lbPair !== params.poolId) throw new Error("Position is not owned by this wallet in this pool");
  if (position.lowerBinId !== params.lowerBinId || position.upperBinId !== params.upperBinId) throw new Error("Position range does not match");
  if (meteoraPositionLiquidity(position) !== 0n) throw new MeteoraOpenBlockedError("Position already has liquidity", "position_not_empty");
  return position;
}

/** 2/2: swap legs (fee inside Jupiter) + add_liquidity_by_strategy2, simulated against the position 1/2 created. */
export async function prepareMeteoraDeposit(params: MeteoraOpenParams, deps: MeteoraOpenDeps): Promise<MeteoraDepositResult> {
  const { connection } = deps;
  const state = await readMeteoraOpenState(connection, params);
  assertEmptyOwnedPosition(state.positionInfo, params);
  if (state.inputBalance < params.amount) throw new MeteoraOpenBlockedError(insufficientInputMessage(params, state), "input_balance_insufficient");
  if (!state.ataXExists || !state.ataYExists) throw new Error("Wallet token accounts from step 1/2 are missing");
  const depositNeed = BigInt(DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE + SIGNATURE_LAMPORTS);
  if (state.walletLamports < depositNeed) {
    throw Object.assign(new MeteoraOpenBlockedError(
      `Not enough SOL: add about ${(Math.ceil(Number(depositNeed - state.walletLamports) / 1e5) / 1e4).toFixed(4)} SOL to finish step 2/2, or close the empty position to get its rent back.`,
      "sol_insufficient",
    ), { minimum: minimumCheck(state.walletLamports, depositNeed) });
  }
  const wallet = new PublicKey(params.wallet);
  const latest = await connection.getLatestBlockhash("confirmed");
  const built = await compileMeteoraDeposit(connection, params, state, deps, latest.blockhash, { compactAtas: true });
  const position = new PublicKey(params.position);
  const sim = await simulate(connection, built.transaction, [position, wallet, state.inputAta], state.slot);
  const positionAfter = accountData(sim.accounts?.[0]);
  if (!positionAfter || !isMeteoraPositionAccount(positionAfter)) throw new Error("Simulation lost the position account");
  const liquidity = meteoraPositionLiquidity(decodeMeteoraPosition(positionAfter));
  if (liquidity <= 0n) throw new Error("Simulation added no liquidity");
  const solDebit = state.walletLamports - BigInt(sim.accounts?.[1]?.lamports ?? 0);
  if (solDebit > BigInt(DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE)) throw new Error("2/2 simulation debits more SOL than allowed");
  const inputAfter = accountData(sim.accounts?.[2]);
  const inputAfterAmount = inputAfter ? unpackAccount(state.inputAta, { data: inputAfter, owner: TOKEN_PROGRAM_ID, lamports: 0, executable: false }, TOKEN_PROGRAM_ID).amount : 0n;
  const inputSpend = state.inputBalance - inputAfterAmount;
  if (inputSpend > params.amount) throw new Error("2/2 simulation spends more input than requested");
  const units = measuredComputeUnitLimit(sim.unitsConsumed ?? 0);
  const instructions = built.instructions.map((ix, index) => (index === 0 ? cuLimit(units) : ix));
  assertMeteoraFeeRule(instructions, built.config);
  const transaction = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: latest.blockhash, instructions }, built.tables).transaction;
  const sizeBytes = assertOpenTransactionSize(transaction);
  return {
    protocol: METEORA_OPEN_PROTOCOL, step: 2, of: 2, wallet: params.wallet, poolId: params.poolId, position: params.position,
    lowerBinId: params.lowerBinId, upperBinId: params.upperBinId, activeId: state.lbPair.activeId, inputMint: params.inputMint, amount: params.amount.toString(),
    transaction: Buffer.from(transaction.serialize()).toString("base64"), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, sizeBytes,
    simulation: { ok: true, unitsConsumed: sim.unitsConsumed ?? 0, computeUnitLimit: units, logsTail: (sim.logs ?? []).slice(-4), solDebitLamports: solDebit.toString() },
    fee: { bps: built.config.bps, chargedOn: "swapped portion only", collection: "Jupiter platformFeeBps into the fee wallet's pre-existing input-mint ATA" },
    legs: built.legs, amountX: built.amountX.toString(), amountY: built.amountY.toString(),
    positionLiquidityAfter: liquidity.toString(), inputSpend: inputSpend.toString(),
  };
}

export type MeteoraCloseResult = {
  protocol: typeof METEORA_OPEN_PROTOCOL; action: "close-refund"; wallet: string; position: string;
  transaction: string; blockhash: string; lastValidBlockHeight: number; sizeBytes: number;
  refundLamports: string; simulation: MeteoraSimulation;
};

/** Close-and-refund for an empty position (step 2/2 failed or abandoned): close_position2, rent back to the wallet. */
export async function prepareMeteoraCloseRefund(input: { wallet: string; position: string; poolId: string }, deps: MeteoraOpenDeps): Promise<MeteoraCloseResult> {
  const { connection } = deps;
  const wallet = new PublicKey(input.wallet);
  const positionKey = new PublicKey(input.position);
  spec(input.poolId);
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([positionKey, wallet], "confirmed");
  const info = value[0] ?? null;
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) {
    throw new MeteoraOpenBlockedError("Position account not found", "position_missing");
  }
  const position = decodeMeteoraPosition(info.data);
  assertEmptyOwnedPosition(info, { wallet: input.wallet, poolId: input.poolId, lowerBinId: position.lowerBinId, upperBinId: position.upperBinId });
  const latest = await connection.getLatestBlockhash("confirmed");
  const close = (units: number) => [cuLimit(units), meteoraClosePosition2Instruction({ position: positionKey, sender: wallet, rentReceiver: wallet })];
  const sim = await simulate(connection, compileV0(wallet, latest.blockhash, close(200_000)), [positionKey, wallet], context.slot);
  const refund = BigInt(sim.accounts?.[1]?.lamports ?? 0) - BigInt(value[1]?.lamports ?? 0);
  if (refund <= 0n) throw new Error("Close simulation did not refund the position rent");
  const units = measuredComputeUnitLimit(sim.unitsConsumed ?? 0);
  const instructions = close(units);
  assertMeteoraFeeRule(instructions, (deps.feeConfig ?? readSwapFeeConfig)());
  const transaction = compileV0(wallet, latest.blockhash, instructions);
  return {
    protocol: METEORA_OPEN_PROTOCOL, action: "close-refund", wallet: input.wallet, position: input.position,
    transaction: Buffer.from(transaction.serialize()).toString("base64"), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
    sizeBytes: assertOpenTransactionSize(transaction), refundLamports: refund.toString(),
    simulation: { ok: true, unitsConsumed: sim.unitsConsumed ?? 0, computeUnitLimit: units, logsTail: (sim.logs ?? []).slice(-4), solDebitLamports: (-refund).toString() },
  };
}
