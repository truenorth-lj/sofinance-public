import "@/lib/engine-host";
import "server-only";

import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { meteoraBinArrayAddress, meteoraBinArrayIndexesForRange } from "@sofinance/engine/protocols/meteora/accounts";
import { meteoraClaimFee2Instruction, meteoraRemoveLiquidityByRange2Instruction, METEORA_BPS_MAX } from "@sofinance/engine/protocols/meteora/liquidity";
import { meteoraBitmapExtensionAddress, meteoraClosePosition2Instruction, meteoraRangeNeedsBitmapExtension } from "@sofinance/engine/protocols/meteora/open";
import { decodeMeteoraPosition, isMeteoraPositionAccount, meteoraPositionLiquidity, type MeteoraPosition } from "@sofinance/engine/protocols/meteora/position";
import { MIN_SOL_LAMPORTS, SLIPPAGE_BPS } from "@sofinance/engine/ids";
import { assertOpenTransactionSize, compileCompactOpenTransaction } from "@sofinance/engine/open-transaction";
import { ATOMIC_COMPUTE_UNIT_LIMIT, measuredComputeUnitLimit } from "@sofinance/engine/transaction-limits";
import { assertMeteoraFeeRule, DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE } from "@/lib/meteora-open";
import type { DexDepositInput, WithdrawRequest } from "../adapter";
import { DexError, DexUnsupportedError } from "../errors";
import {
  accountData, compileDeposit, compileV0, cuLimit, encode, planMeteoraOpen, publicKey, readMeteoraPool, readWallet, simulate, sol,
  SIGNATURE_LAMPORTS, tokenAccount, type BuiltStep, type MeteoraOpenDeps, type MeteoraPoolState,
} from "./open.server";

/**
 * Meteora DLMM add / withdraw / claim behind the shared DEX contract (DESIGN.md §3 PR6). One wallet step each.
 *   add       Jupiter legs for the part of the input that is not a pool token (fee = the descriptor's `add` rule,
 *             swap-input-bps, inside the Jupiter swap into the fee wallet's pre-existing ATA), then
 *             `add_liquidity_by_strategy2` (Spot) over the position's own range. Listed pools only.
 *   withdraw  partial: `remove_liquidity_by_range2` for the share (fees stay in the position).
 *             full:    remove 100% + `claim_fee2` + `close_position2` (the position rent comes back to the owner).
 *             Pool tokens only (no fee, the `withdrawPoolTokens` rule); to-USDC is refused.
 *   claim     `claim_fee2` over the position's range (no fee, the `claim` rule).
 * Every op: the position is read fresh and its decoded owner must equal the requesting wallet (here, not only in the
 * route: MCP and other callers reach the adapter directly). Add and withdraw run `assertMeteoraPoolMintsUsable` (via
 * readMeteoraPool), and claim does too (it moves the same tokens). Nothing creates a bin array or the bitmap extension:
 * a missing one refuses. Every transaction runs `assertMeteoraFeeRule` and is simulated before it is returned.
 * Nothing here signs or sends.
 */

export type OwnedMeteoraPosition = { address: string; decoded: MeteoraPosition; info: AccountInfo<Buffer>; liquidity: bigint };

/** The position, read fresh, owned by `owner` (the decoded on-chain owner, not a claim from the request). */
export function assertOwnedPosition(info: AccountInfo<Buffer> | null, address: string, owner: string): OwnedMeteoraPosition {
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) {
    throw new DexError("POSITION_NOT_FOUND", "That Meteora position was not found on chain. It may already be closed.");
  }
  const decoded = decodeMeteoraPosition(info.data);
  if (decoded.owner !== owner) throw new DexError("POSITION_NOT_FOUND", "That Meteora position belongs to another wallet.");
  return { address, decoded, info, liquidity: meteoraPositionLiquidity(decoded) };
}

async function readOwned(deps: Pick<MeteoraOpenDeps, "connection">, position: string, owner: string) {
  const positionKey = publicKey(position, "position");
  publicKey(owner, "wallet");
  const info = await deps.connection.getAccountInfo(positionKey, "confirmed");
  return assertOwnedPosition(info ?? null, positionKey.toBase58(), owner);
}

/**
 * The shared accounts a position's range touches must already exist: every bin array and, past the default bitmap,
 * the bitmap extension. Withdraw and claim never create them (no new bin arrays, PM ruling).
 */
async function existingRangeAccounts(deps: Pick<MeteoraOpenDeps, "connection">, pool: MeteoraPoolState, lowerBinId: number, upperBinId: number) {
  const indexes = meteoraBinArrayIndexesForRange(lowerBinId, upperBinId);
  const bitmap = meteoraBitmapExtensionAddress(pool.poolId);
  const needsBitmap = meteoraRangeNeedsBitmapExtension(lowerBinId, upperBinId);
  const keys = [bitmap, ...indexes.map((index) => new PublicKey(meteoraBinArrayAddress(pool.poolId, index)))];
  const infos = await deps.connection.getMultipleAccountsInfo(keys, "confirmed");
  const owned = (i: number) => !!infos[i] && infos[i]!.owner.toBase58() === METEORA_DLMM_PROGRAM_ID;
  if (indexes.some((_, i) => !owned(i + 1))) {
    throw new DexError("UPSTREAM", "A shared Meteora account (bin array) this position uses was not found on chain, so nothing was built.");
  }
  if (needsBitmap && !owned(0)) {
    throw new DexError("UPSTREAM", "This position's range needs the pool's bitmap extension account, which was not found on chain, so nothing was built.");
  }
  return needsBitmap ? bitmap : undefined;
}

type OwnerTokens = {
  wallet: PublicKey; ataX: PublicKey; ataY: PublicKey; ataXExists: boolean; ataYExists: boolean;
  balanceX: bigint; balanceY: bigint; walletLamports: bigint; slot: number;
};

async function readOwnerTokens(deps: Pick<MeteoraOpenDeps, "connection">, pool: MeteoraPoolState, owner: string): Promise<OwnerTokens> {
  const wallet = new PublicKey(owner);
  const { lbPair } = pool;
  const ataX = getAssociatedTokenAddressSync(new PublicKey(lbPair.tokenXMint), wallet, false, new PublicKey(pool.tokenProgramX));
  const ataY = getAssociatedTokenAddressSync(new PublicKey(lbPair.tokenYMint), wallet, false, new PublicKey(pool.tokenProgramY));
  const { context, value: [walletInfo, ataXInfo, ataYInfo] } = await deps.connection.getMultipleAccountsInfoAndContext([wallet, ataX, ataY], "confirmed");
  const x = tokenAccount(ataXInfo ?? null, ataX, wallet, lbPair.tokenXMint, pool.tokenProgramX);
  const y = tokenAccount(ataYInfo ?? null, ataY, wallet, lbPair.tokenYMint, pool.tokenProgramY);
  return {
    wallet, ataX, ataY, ataXExists: x.exists, ataYExists: y.exists, balanceX: x.amount, balanceY: y.amount,
    walletLamports: BigInt(walletInfo?.lamports ?? 0), slot: context.slot,
  };
}

function ataCreates(pool: MeteoraPoolState, tokens: OwnerTokens): TransactionInstruction[] {
  const { wallet } = tokens;
  const { lbPair } = pool;
  return [
    ...(tokens.ataXExists ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, tokens.ataX, wallet, new PublicKey(lbPair.tokenXMint), new PublicKey(pool.tokenProgramX))]),
    ...(tokens.ataYExists ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, tokens.ataY, wallet, new PublicKey(lbPair.tokenYMint), new PublicKey(pool.tokenProgramY))]),
  ];
}

function poolAccounts(pool: MeteoraPoolState, tokens: OwnerTokens, position: string) {
  const { lbPair } = pool;
  return {
    lbPair: new PublicKey(pool.poolId), position: new PublicKey(position), sender: tokens.wallet,
    userTokenX: tokens.ataX, userTokenY: tokens.ataY, reserveX: new PublicKey(lbPair.reserveX), reserveY: new PublicKey(lbPair.reserveY),
    tokenXMint: new PublicKey(lbPair.tokenXMint), tokenYMint: new PublicKey(lbPair.tokenYMint),
    tokenXProgram: new PublicKey(pool.tokenProgramX), tokenYProgram: new PublicKey(pool.tokenProgramY),
  };
}

/** Token amount in a simulated account (a missing account counts as 0). */
function simulatedAmount(data: Buffer | null, address: PublicKey, program: string) {
  if (!data) return 0n;
  const owner = new PublicKey(program);
  return unpackAccount(address, { data, owner, lamports: 0, executable: false }, owner).amount;
}

/** Withdraw share in bps: (0, 1] → 1..10,000, rounded down, never 0. */
export function meteoraWithdrawBps(fraction: number) {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new DexError("INVALID_REQUEST", "The withdraw share must be above 0 and at most 100%.");
  return fraction === 1 ? METEORA_BPS_MAX : Math.max(1, Math.min(METEORA_BPS_MAX - 1, Math.floor(fraction * METEORA_BPS_MAX)));
}

/** Single-step builds share this: simulate, check the owner's tokens and SOL, then recompile with the measured CU limit. */
async function simulateAndFinish(
  deps: Pick<MeteoraOpenDeps, "connection" | "feeConfig">, pool: MeteoraPoolState, tokens: OwnerTokens, position: string,
  body: (units: number) => TransactionInstruction[], what: string, maxSolDebit: bigint,
  check: (after: { position: Buffer | null; positionLamports: bigint; x: bigint; y: bigint; walletLamports: bigint }) => void,
): Promise<BuiltStep> {
  const { connection } = deps;
  const latest = await connection.getLatestBlockhash("confirmed");
  assertMeteoraFeeRule(body(ATOMIC_COMPUTE_UNIT_LIMIT), deps.feeConfig());
  const positionKey = new PublicKey(position);
  const sim = await simulate(connection, compileV0(tokens.wallet, latest.blockhash, body(ATOMIC_COMPUTE_UNIT_LIMIT)),
    [positionKey, tokens.wallet, tokens.ataX, tokens.ataY], tokens.slot, what);
  const walletLamports = BigInt(sim.accounts?.[1]?.lamports ?? 0);
  const x = simulatedAmount(accountData(sim.accounts?.[2]), tokens.ataX, pool.tokenProgramX);
  const y = simulatedAmount(accountData(sim.accounts?.[3]), tokens.ataY, pool.tokenProgramY);
  if (x < tokens.balanceX || y < tokens.balanceY) throw new DexError("UPSTREAM", `The ${what} simulation takes pool tokens out of your wallet, so nothing was sent.`);
  if (tokens.walletLamports - walletLamports > maxSolDebit) throw new DexError("UPSTREAM", `The ${what} simulation spends more SOL than the network fee and token accounts shown, so nothing was sent.`);
  check({ position: accountData(sim.accounts?.[0]), positionLamports: BigInt(sim.accounts?.[0]?.lamports ?? 0), x, y, walletLamports });
  const final = body(measuredComputeUnitLimit(sim.unitsConsumed ?? 0));
  assertMeteoraFeeRule(final, deps.feeConfig());
  const transaction = compileV0(tokens.wallet, latest.blockhash, final);
  assertOpenTransactionSize(transaction);
  return { transaction: encode(transaction), lastValidBlockHeight: latest.lastValidBlockHeight };
}

/**
 * Upper bound on the rent of the owner's missing pool-token accounts. A Token-2022 account carries extensions
 * (ImmutableOwner, and per mint e.g. PausableAccount), so it is larger than a 165-byte SPL account; 300 bytes covers
 * them. The simulated SOL debit is checked against this bound, never trusted from it.
 */
const TOKEN_ACCOUNT_RENT_BOUND = 3_000_000n;
function tokenAccountRent(tokens: OwnerTokens) {
  return TOKEN_ACCOUNT_RENT_BOUND * BigInt(Number(!tokens.ataXExists) + Number(!tokens.ataYExists));
}

export type MeteoraWithdrawBuilt = BuiltStep & { full: boolean; bps: number; rentRefundLamports: bigint };

export async function buildMeteoraWithdraw(deps: MeteoraOpenDeps, position: string, owner: string, request: WithdrawRequest): Promise<MeteoraWithdrawBuilt> {
  if (request.output !== "pool-tokens") {
    throw new DexUnsupportedError(`Withdrawing straight to ${request.output === "sol" ? "SOL" : "USDC"} isn't available for this pool yet. Withdraw to the pool's two tokens instead.`);
  }
  const bps = meteoraWithdrawBps(request.fraction);
  const full = bps === METEORA_BPS_MAX;
  const owned = await readOwned(deps, position, owner);
  const pool = await readMeteoraPool(deps, owned.decoded.lbPair, { requireListed: false });
  const { lowerBinId, upperBinId } = owned.decoded;
  // Farming rewards: closing a position needs its rewards claimed first, and this build has no reward claim. Neither RWA
  // pool has rewards set up (checked on mainnet 11/1, DESIGN.md), so this only fires if a pool adds them later: refuse
  // the close in plain words rather than build a transaction that would fail on chain.
  if (full && pool.lbPair.rewardMints.length) {
    throw new DexError("UNSUPPORTED", "This pool pays farming rewards, and claiming them isn't available here yet. A position must have its rewards claimed before it can be closed, so nothing was built. You can still withdraw part of the position.");
  }
  if (!full && owned.liquidity === 0n) throw new DexError("INVALID_REQUEST", "This position holds no liquidity, so there is nothing to withdraw. Withdraw 100% to close it and get its rent back.");
  const bitmapExtension = await existingRangeAccounts(deps, pool, lowerBinId, upperBinId);
  const tokens = await readOwnerTokens(deps, pool, owner);
  const accounts = poolAccounts(pool, tokens, position);
  const creates = ataCreates(pool, tokens);
  const body = (units: number) => [
    cuLimit(units), ...creates,
    ...(owned.liquidity > 0n ? [meteoraRemoveLiquidityByRange2Instruction({ ...accounts, fromBinId: lowerBinId, toBinId: upperBinId, bps, ...(bitmapExtension ? { bitmapExtension } : {}) })] : []),
    ...(full ? [
      meteoraClaimFee2Instruction({ ...accounts, minBinId: lowerBinId, maxBinId: upperBinId }),
      meteoraClosePosition2Instruction({ position: accounts.position, sender: tokens.wallet, rentReceiver: tokens.wallet }),
    ] : []),
  ];
  const ataRent = tokenAccountRent(tokens);
  const maxDebit = ataRent + SIGNATURE_LAMPORTS;
  if (tokens.walletLamports < maxDebit) throw new DexError("INSUFFICIENT_FUNDS", `Not enough SOL for the network fee${ataRent ? " and token accounts" : ""}: add about ${sol(maxDebit - tokens.walletLamports)} SOL.`);
  const rentRefundLamports = full ? BigInt(owned.info.lamports) : 0n;
  const built = await simulateAndFinish(deps, pool, tokens, position, body, full ? "withdraw and close" : "withdraw", maxDebit, (after) => {
    if (full) {
      if (after.position && after.positionLamports > 0n) throw new DexError("UPSTREAM", "The withdraw simulation did not close the position, so nothing was sent.");
      return;
    }
    if (!after.position || !isMeteoraPositionAccount(after.position)) throw new DexError("UPSTREAM", "The withdraw simulation removed the position account, so nothing was sent.");
    const left = meteoraPositionLiquidity(decodeMeteoraPosition(after.position));
    if (left >= owned.liquidity) throw new DexError("UPSTREAM", "The withdraw simulation removed no liquidity, so nothing was sent.");
  });
  return { ...built, full, bps, rentRefundLamports };
}

export type MeteoraClaimBuilt = BuiltStep;

export async function buildMeteoraClaim(deps: MeteoraOpenDeps, position: string, owner: string): Promise<MeteoraClaimBuilt> {
  const owned = await readOwned(deps, position, owner);
  const pool = await readMeteoraPool(deps, owned.decoded.lbPair, { requireListed: false });
  const { lowerBinId, upperBinId } = owned.decoded;
  await existingRangeAccounts(deps, pool, lowerBinId, upperBinId);
  const tokens = await readOwnerTokens(deps, pool, owner);
  const accounts = poolAccounts(pool, tokens, position);
  const creates = ataCreates(pool, tokens);
  const body = (units: number) => [cuLimit(units), ...creates, meteoraClaimFee2Instruction({ ...accounts, minBinId: lowerBinId, maxBinId: upperBinId })];
  const ataRent = tokenAccountRent(tokens);
  const maxDebit = ataRent + SIGNATURE_LAMPORTS;
  if (tokens.walletLamports < maxDebit) throw new DexError("INSUFFICIENT_FUNDS", `Not enough SOL for the network fee${ataRent ? " and token accounts" : ""}: add about ${sol(maxDebit - tokens.walletLamports)} SOL.`);
  return simulateAndFinish(deps, pool, tokens, position, body, "claim", maxDebit, (after) => {
    if (!after.position || !isMeteoraPositionAccount(after.position)) throw new DexError("UPSTREAM", "The claim simulation changed the position account, so nothing was sent.");
    if (meteoraPositionLiquidity(decodeMeteoraPosition(after.position)) !== owned.liquidity) {
      throw new DexError("UPSTREAM", "The claim simulation changed the position's liquidity, so nothing was sent.");
    }
  });
}

export async function buildMeteoraAdd(deps: MeteoraOpenDeps, position: string, owner: string, input: DexDepositInput): Promise<BuiltStep> {
  const owned = await readOwned(deps, position, owner);
  // Listed pools only (same list as opening), and the Token-2022 mint guard.
  const pool = await readMeteoraPool(deps, owned.decoded.lbPair);
  const { lowerBinId, upperBinId } = owned.decoded;
  const request = { poolId: pool.poolId, owner, input, slippageBps: SLIPPAGE_BPS, range: { kind: "units", lower: lowerBinId, upper: upperBinId } } as const;
  // planMeteoraOpen runs the range rules (≤70 bins, existing bin arrays, existing bitmap extension: no new shared accounts)
  // and prices the platform fee from the `add` rule.
  const plan = await planMeteoraOpen(deps, request, pool, { lowerBinId, upperBinId }, "add");
  const state = await readWallet(deps.connection, plan, owner, position);
  if (state.inputBalance < plan.amount) {
    throw new DexError("INSUFFICIENT_FUNDS", `Your wallet holds ${state.inputBalance} raw units of the input token but this add needs ${plan.amount}. Lower the amount or add more.`);
  }
  const tokens = await readOwnerTokens(deps, pool, owner);
  const creates = ataCreates(pool, tokens);
  const ataRent = tokenAccountRent(tokens);
  const need = BigInt(DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE) + ataRent + SIGNATURE_LAMPORTS + BigInt(MIN_SOL_LAMPORTS);
  if (state.walletLamports < need) {
    throw new DexError("INSUFFICIENT_FUNDS", `Not enough SOL: this add needs about ${sol(need)} SOL (network fees, temporary swap accounts and a ${sol(BigInt(MIN_SOL_LAMPORTS))} SOL reserve); your wallet has ${sol(state.walletLamports)} SOL.`);
  }
  const wallet = new PublicKey(owner);
  const latest = await deps.connection.getLatestBlockhash("confirmed");
  const built = await compileDeposit(deps, plan, state, owner, position, latest.blockhash, true, creates);
  const positionKey = new PublicKey(position);
  const sim = await simulate(deps.connection, built.transaction, [positionKey, wallet, state.inputAta], state.slot, "add");
  const after = accountData(sim.accounts?.[0]);
  if (!after || !isMeteoraPositionAccount(after) || meteoraPositionLiquidity(decodeMeteoraPosition(after)) <= owned.liquidity) {
    throw new DexError("UPSTREAM", "The add simulation added no liquidity to the position, so nothing was sent.");
  }
  const solDebit = state.walletLamports - BigInt(sim.accounts?.[1]?.lamports ?? 0);
  if (solDebit > BigInt(DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE) + ataRent) throw new DexError("UPSTREAM", "The add simulation spends more SOL than allowed, so nothing was sent.");
  const inputAfter = accountData(sim.accounts?.[2]);
  const inputProgram = new PublicKey(plan.inputProgram);
  const remaining = inputAfter ? unpackAccount(state.inputAta, { data: inputAfter, owner: inputProgram, lamports: 0, executable: false }, inputProgram).amount : 0n;
  if (state.inputBalance - remaining > plan.amount) throw new DexError("UPSTREAM", "The add simulation spends more of your token than requested, so nothing was sent.");
  const instructions = built.instructions.map((ix, index) => (index === 0 ? cuLimit(measuredComputeUnitLimit(sim.unitsConsumed ?? 0)) : ix));
  assertMeteoraFeeRule(instructions, deps.feeConfig());
  const transaction = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: latest.blockhash, instructions }, built.tables).transaction;
  assertOpenTransactionSize(transaction);
  return { transaction: encode(transaction), lastValidBlockHeight: latest.lastValidBlockHeight };
}

