import "@/lib/engine-host";
import "server-only";

import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { meteoraBinArrayAddress, meteoraBinArrayIndexesForRange } from "@sofinance/engine/protocols/meteora/accounts";
import { meteoraClaimFee2Instruction, meteoraRemoveLiquidityByRange2Instruction, METEORA_BPS_MAX } from "@sofinance/engine/protocols/meteora/liquidity";
import { meteoraBitmapExtensionAddress, meteoraClosePosition2Instruction, meteoraRangeNeedsBitmapExtension } from "@sofinance/engine/protocols/meteora/open";
import { decodeMeteoraPosition, isMeteoraPositionAccount, meteoraPositionLiquidity, meteoraRangeSide, type MeteoraPosition } from "@sofinance/engine/protocols/meteora/position";
import { meteoraAddLiquidityByStrategy2Instruction, meteoraMaxActiveBinSlippage } from "@sofinance/engine/protocols/meteora/open";
import { MIN_SOL_LAMPORTS, SLIPPAGE_BPS } from "@sofinance/engine/ids";
import { assertOpenTransactionSize, compileCompactOpenTransaction } from "@sofinance/engine/open-transaction";
import { ATOMIC_COMPUTE_UNIT_LIMIT, measuredComputeUnitLimit } from "@sofinance/engine/transaction-limits";
import { assertMeteoraFeeRule } from "@/lib/meteora-open";
import type { AddQuote, DexDepositInput, WithdrawRequest } from "../adapter";
import { meteoraDepositMinimum, type MeteoraLegQuote } from "./minimum.server";
import { DexError, DexUnsupportedError } from "../errors";
import {
  accountData, compileDeposit, compileV0, cuLimit, depositIntermediateRentAllowance, encode, missingPoolTokenAccounts, planMeteoraOpen, publicKey,
  readMeteoraPool, readWallet, simulate, sol, SIGNATURE_LAMPORTS, sumRent, tokenAccount, type BuiltStep, type MeteoraOpenDeps, type MeteoraPoolState,
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
 *   compound  (PR8) `claim_fee2` then `add_liquidity_by_strategy2` (SpotImBalanced, no swap) of exactly the claimed amounts
 *             over the position's own range, in one transaction. No swap, so no fee (the `compound` rule is none, PM 11/1)
 *             and no transfer instruction. Listed pools only (it deposits, like add).
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

/** Withdraw share in bps: (0, 1] → 1..10,000, rounded to the nearest bps; only exactly 1 is 10,000 (close), never 0. */
export function meteoraWithdrawBps(fraction: number) {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new DexError("INVALID_REQUEST", "The withdraw share must be above 0 and at most 100%.");
  // Rounded, not floored: 0.57 * 10,000 is 5699.999… in floating point, and the user asked for 57% (PM review of #289).
  return fraction === 1 ? METEORA_BPS_MAX : Math.max(1, Math.min(METEORA_BPS_MAX - 1, Math.round(fraction * METEORA_BPS_MAX)));
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

/** Rent of the owner's missing pool-token accounts, per mint's program and extensions (PR9.2: no fixed per-account bound). */
async function tokenAccountRent(deps: MeteoraOpenDeps, pool: MeteoraPoolState, tokens: OwnerTokens) {
  const created = await missingPoolTokenAccounts(deps.connection, pool, tokens);
  return { created, lamports: sumRent(created) };
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
  const { lamports: ataRent } = await tokenAccountRent(deps, pool, tokens);
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
  const { lamports: ataRent } = await tokenAccountRent(deps, pool, tokens);
  const maxDebit = ataRent + SIGNATURE_LAMPORTS;
  if (tokens.walletLamports < maxDebit) throw new DexError("INSUFFICIENT_FUNDS", `Not enough SOL for the network fee${ataRent ? " and token accounts" : ""}: add about ${sol(maxDebit - tokens.walletLamports)} SOL.`);
  return simulateAndFinish(deps, pool, tokens, position, body, "claim", maxDebit, (after) => {
    if (!after.position || !isMeteoraPositionAccount(after.position)) throw new DexError("UPSTREAM", "The claim simulation changed the position account, so nothing was sent.");
    if (meteoraPositionLiquidity(decodeMeteoraPosition(after.position)) !== owned.liquidity) {
      throw new DexError("UPSTREAM", "The claim simulation changed the position's liquidity, so nothing was sent.");
    }
  });
}

/** The plan an Add of `input` into `position` would use (same range rules and fee rule as the build). */
async function planMeteoraAdd(deps: MeteoraOpenDeps, position: string, owner: string, input: DexDepositInput) {
  const owned = await readOwned(deps, position, owner);
  // Listed pools only (same list as opening), and the Token-2022 mint guard.
  const pool = await readMeteoraPool(deps, owned.decoded.lbPair);
  const { lowerBinId, upperBinId } = owned.decoded;
  const request = { poolId: pool.poolId, owner, input, slippageBps: SLIPPAGE_BPS, range: { kind: "units", lower: lowerBinId, upper: upperBinId } } as const;
  // planMeteoraOpen runs the range rules (≤70 bins, existing bin arrays, existing bitmap extension: no new shared accounts)
  // and prices the platform fee from the `add` rule.
  return { owned, pool, plan: await planMeteoraOpen(deps, request, pool, { lowerBinId, upperBinId }, "add") };
}

/** Quote-time check of an Add: whether the amount reaches every bin of the position's range (see `meteoraDepositMinimum`). */
export async function quoteMeteoraAdd(deps: MeteoraOpenDeps, position: string, owner: string, input: DexDepositInput, quoteLeg?: MeteoraLegQuote): Promise<AddQuote> {
  const { plan } = await planMeteoraAdd(deps, position, owner, input);
  const depositMinimum = await meteoraDepositMinimum(plan, owner, quoteLeg);
  return depositMinimum ? { depositMinimum } : {};
}

export async function buildMeteoraAdd(deps: MeteoraOpenDeps, position: string, owner: string, input: DexDepositInput): Promise<BuiltStep> {
  const { owned, pool, plan } = await planMeteoraAdd(deps, position, owner, input);
  const state = await readWallet(deps.connection, plan, owner, position);
  if (state.inputBalance < plan.amount) {
    throw new DexError("INSUFFICIENT_FUNDS", `Your wallet holds ${state.inputBalance} raw units of the input token but this add needs ${plan.amount}. Lower the amount or add more.`);
  }
  const tokens = await readOwnerTokens(deps, pool, owner);
  const creates = ataCreates(pool, tokens);
  const { lamports: ataRent } = await tokenAccountRent(deps, pool, tokens);
  const allowance = await depositIntermediateRentAllowance(deps.connection);
  const need = allowance + ataRent + SIGNATURE_LAMPORTS + BigInt(MIN_SOL_LAMPORTS);
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
  if (solDebit > allowance + ataRent) throw new DexError("UPSTREAM", "The add simulation spends more SOL than allowed, so nothing was sent.");
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


export type MeteoraCompoundBuilt = BuiltStep & {
  /** Raw fee amounts put back into the position. */
  compoundX: bigint; compoundY: bigint;
  /**
   * Wallet token accounts this step creates (the claim pays into them) and their rent, per mint's program and
   * extensions (Token-2022 sizes included); the same figure caps the simulated SOL debit. Stated to the user before signing (PM review of #289).
   */
  createdTokenAccounts: { mint: string; rentLamports: bigint }[];
  /** Raw fee amounts that go to the wallet instead: the side an out-of-range position cannot hold at the current price. */
  leftoverX: bigint; leftoverY: bigint;
};

/**
 * Compound (PR8): claim the position's fees and deposit them back into the same range, in one transaction. The claimed
 * amounts are measured by simulating the claim alone first; fees only grow, so the real claim pays at least that much
 * and the deposit never draws on tokens the wallet already held (the final simulation checks the wallet's pool-token
 * balances do not fall). Out of range, a Spot deposit can only hold one token (X above the price, Y below): the other
 * side's fees stay in the wallet, and the label says so.
 */
export async function buildMeteoraCompound(deps: MeteoraOpenDeps, position: string, owner: string): Promise<MeteoraCompoundBuilt> {
  const owned = await readOwned(deps, position, owner);
  // It deposits, so the same rule as add: listed pools only, and the Token-2022 mint guard.
  const pool = await readMeteoraPool(deps, owned.decoded.lbPair);
  const { lowerBinId, upperBinId } = owned.decoded;
  const bitmapExtension = await existingRangeAccounts(deps, pool, lowerBinId, upperBinId);
  const tokens = await readOwnerTokens(deps, pool, owner);
  const accounts = poolAccounts(pool, tokens, position);
  const creates = ataCreates(pool, tokens);
  const { created, lamports: ataRent } = await tokenAccountRent(deps, pool, tokens);
  const maxDebit = ataRent + SIGNATURE_LAMPORTS;
  if (tokens.walletLamports < maxDebit) throw new DexError("INSUFFICIENT_FUNDS", `Not enough SOL for the network fee${ataRent ? " and token accounts" : ""}: add about ${sol(maxDebit - tokens.walletLamports)} SOL.`);
  const claim = meteoraClaimFee2Instruction({ ...accounts, minBinId: lowerBinId, maxBinId: upperBinId });

  // 1. What the claim pays right now.
  const latest = await deps.connection.getLatestBlockhash("confirmed");
  const claimOnly = [cuLimit(ATOMIC_COMPUTE_UNIT_LIMIT), ...creates, claim];
  assertMeteoraFeeRule(claimOnly, deps.feeConfig());
  const probe = await simulate(deps.connection, compileV0(tokens.wallet, latest.blockhash, claimOnly), [tokens.ataX, tokens.ataY], tokens.slot, "fee claim");
  const claimedX = simulatedAmount(accountData(probe.accounts?.[0]), tokens.ataX, pool.tokenProgramX) - tokens.balanceX;
  const claimedY = simulatedAmount(accountData(probe.accounts?.[1]), tokens.ataY, pool.tokenProgramY) - tokens.balanceY;
  const createdTokenAccounts = created;
  if (claimedX <= 0n && claimedY <= 0n) throw new DexError("INVALID_REQUEST", "This position has no unclaimed fees yet, so there is nothing to compound.");

  // 2. What the range can hold at the current price (bins above the active bin hold X, below hold Y).
  const side = meteoraRangeSide(pool.lbPair.activeId, lowerBinId, upperBinId);
  const compoundX = side === "above" ? 0n : claimedX > 0n ? claimedX : 0n;
  const compoundY = side === "below" ? 0n : claimedY > 0n ? claimedY : 0n;
  if (compoundX === 0n && compoundY === 0n) {
    throw new DexError("INVALID_REQUEST", "The price is outside this position's range, and its fees are all in the token the range can't hold right now, so they can't be compounded. Claim them to your wallet instead.");
  }
  const add = meteoraAddLiquidityByStrategy2Instruction({
    ...accounts, amountX: compoundX, amountY: compoundY,
    activeId: pool.lbPair.activeId, maxActiveBinSlippage: meteoraMaxActiveBinSlippage(SLIPPAGE_BPS, pool.lbPair.binStep),
    minBinId: lowerBinId, maxBinId: upperBinId, ...(bitmapExtension ? { bitmapExtension } : {}),
  });

  // 3. Claim + deposit, simulated: liquidity must grow and the wallet's pool-token balances must not fall.
  const body = (units: number) => [cuLimit(units), ...creates, claim, add];
  const built = await simulateAndFinish(deps, pool, tokens, position, body, "compound", maxDebit, (after) => {
    if (!after.position || !isMeteoraPositionAccount(after.position)) throw new DexError("UPSTREAM", "The compound simulation removed the position account, so nothing was sent.");
    if (meteoraPositionLiquidity(decodeMeteoraPosition(after.position)) <= owned.liquidity) {
      throw new DexError("UPSTREAM", "The compound simulation added no liquidity to the position, so nothing was sent.");
    }
  });
  const positive = (value: bigint) => (value > 0n ? value : 0n);
  return { ...built, compoundX, compoundY, leftoverX: positive(claimedX) - compoundX, leftoverY: positive(claimedY) - compoundY, createdTokenAccounts };
}
