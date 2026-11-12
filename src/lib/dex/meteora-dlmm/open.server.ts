import "@/lib/engine-host";
import "server-only";

import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { decodeLbPair, type LbPairState } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_DLMM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { decodeMeteoraPosition, isMeteoraPositionAccount, meteoraPositionLiquidity, type MeteoraPosition } from "@sofinance/engine/protocols/meteora/position";
import {
  meteoraAddLiquidityByStrategy2Instruction, meteoraClosePosition2Instruction, meteoraInitializePositionInstruction, meteoraMaxActiveBinSlippage, meteoraSpotSplit,
} from "@sofinance/engine/protocols/meteora/open";
import { fetchMeteoraPositionRent, readMeteoraOpenAccounts } from "@sofinance/engine/protocols/meteora/rent";
import { checkMeteoraPoolMint, meteoraPoolTokenPrograms, type MeteoraMintRestriction } from "@sofinance/engine/protocols/meteora/token";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT, SLIPPAGE_BPS, USDC_MINT } from "@sofinance/engine/ids";
import type { SwapFeeConfig } from "@sofinance/engine/swap/fee";
import { feeSwapLeg } from "@sofinance/engine/swap/leg";
import { swapRouteInstructions } from "@sofinance/engine/swap/instructions";
import type { BuildRoute } from "@sofinance/engine/swap/jupiter";
import { JUPITER_ROUTE_ATTEMPTS, isTxOversizeError, type JupiterRouteConstraints } from "@sofinance/engine/jupiter-route-retry";
import { shortAddress as short } from "@/lib/format/address";
import { assertOpenTransactionSize, compactAtaInstructions, compileCompactOpenTransaction, openLookupTableReader } from "@sofinance/engine/open-transaction";
import { ATOMIC_COMPUTE_UNIT_LIMIT, measuredComputeUnitLimit } from "@sofinance/engine/transaction-limits";
import { withContextSlotRetry } from "@sofinance/engine/rpc/context-slot";
import { associatedTokenAccountRents, maxAssociatedTokenAccountSpace } from "@sofinance/engine/token-account-rent";
import { binTickSqrtPriceX64 } from "@/lib/range-apr/meteora-liquidity";
import { meteoraPresetRanges } from "@/lib/meteora-range-apr";
import { assertMeteoraFeeRule } from "@/lib/meteora-open";
import type { DexFeeStrategy, OpenRangePreset, OpenRequest } from "../adapter";
import { DexError } from "../errors";
import { openSolNeed, type OpenSolParts } from "../sol-need";
import { assertFeeWalletConfigured } from "../fee-wallet.server";
import { feeRuleBps } from "../types";
import { meteoraDlmmDescriptor } from "./descriptor";
import type { ListedMeteoraPool } from "./pools.server";

/**
 * Meteora DLMM open, behind the shared DEX contract (DESIGN.md §3 PR4). Two wallet steps plus a recovery:
 *   1/2 setup    `initialize_position` (fresh browser-held position keypair cosigns) + the wallet's own pool-token
 *                ATAs (SPL or Token-2022 per the LbPair flags). The wallet pays the position rent (~0.0419 SOL for
 *                70 bins), refunded by `close_position2`. No swap, no fee.
 *   2/2 deposit  Jupiter legs for the part of the input that is not already a pool token (fee = Jupiter
 *                `platformFeeBps` in the input mint, into the fee wallet's pre-existing ATA), then
 *                `add_liquidity_by_strategy2` (Spot), with the pool's bitmap extension when the range needs it.
 *   recovery     `close_position2` on an empty position: rent back to the owner.
 * Before anything is built: the pool must be listed (pools.server.ts) and match chain, both mints pass
 * `checkMeteoraPoolMint` (no transfer hook / pause / transfer fee), the range is at most 70 bins, every bin array it
 * covers already exists and, past the default bitmap, so does the bitmap extension. Every transaction runs
 * `assertMeteoraFeeRule` (no instruction touching the fee wallet, no bare SOL transfer). Nothing here signs or sends.
 */

/**
 * Base fee per signature. Every SOL check and simulation cap here counts simulated rent plus this base fee only, never
 * the wallet's priority fee: a wallet that can signAndSendTransaction sends every DEX-route step itself and may add its own
 * SetComputeUnitPrice (Phantom: 97,502 lamports on a 2026-11-01 setup step). That fee is shown and approved in the
 * wallet and is covered by the `MIN_SOL_LAMPORTS` (0.01 SOL) reserve each check keeps (PM, 2026-11-01). A sign-only
 * wallet's step is relayed instead, under the 0.01 SOL wallet priority-fee ceiling.
 */
export const SIGNATURE_LAMPORTS = 5_000n;
const MAX_OPEN_BINS = 70;

export type MeteoraOpenDeps = {
  connection: Connection;
  fees: DexFeeStrategy;
  feeConfig: () => SwapFeeConfig;
  listedPool: (poolId: string) => Promise<ListedMeteoraPool | null>;
};

export type MeteoraPoolState = {
  poolId: string;
  lbPair: LbPairState;
  tokenProgramX: string;
  tokenProgramY: string;
  decimalsX: number;
  decimalsY: number;
  slot: number;
};

export type MeteoraOpenPlan = {
  pool: MeteoraPoolState;
  lowerBinId: number;
  upperBinId: number;
  width: number;
  bitmapExtension: PublicKey | null;
  positionRentLamports: bigint;
  amount: bigint;
  inputMint: string;
  inputProgram: string;
  /** Spend per pool side; a side equal to the input mint is kept, the other is swapped (and charged). */
  sides: { side: "x" | "y"; mint: string; spend: bigint; swapped: boolean }[];
  /** Fee bps per swap leg, from the fee policy (0 only for a policy of "none"; a charging policy without a fee wallet throws). */
  legBps: number;
  platformFeeRaw: bigint;
};

export { short };
export const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);

export function publicKey(value: string, what: string) {
  try {
    return new PublicKey(value);
  } catch {
    throw new DexError("INVALID_REQUEST", `The ${what} is not a valid Solana address.`);
  }
}

/** UI price (token Y per token X) at the lower edge of a bin. */
export function meteoraBinUiPrice(binId: number, binStep: number, decimalsX: number, decimalsY: number) {
  return (1 + binStep / 10_000) ** binId * 10 ** (decimalsX - decimalsY);
}

const RESTRICTION_TEXT: Record<MeteoraMintRestriction, string> = {
  transfer_hook: "runs its issuer's transfer hook on every transfer",
  paused: "has transfers paused by its issuer",
  transfer_fee: "charges a transfer fee",
};

/**
 * The Token-2022 guard (PM 11/1 item 2): both pool mints, read fresh, must be owned by the program the LbPair
 * declares and carry no transfer hook, pause or transfer fee. Runs before open (here) and before add / withdraw
 * (PR6, same helper).
 */
export function assertMeteoraPoolMintsUsable(
  lbPair: LbPairState, mintX: AccountInfo<Buffer> | null, mintY: AccountInfo<Buffer> | null,
) {
  const { tokenProgramX, tokenProgramY } = meteoraPoolTokenPrograms(lbPair);
  const checked = ([[lbPair.tokenXMint, mintX, tokenProgramX], [lbPair.tokenYMint, mintY, tokenProgramY]] as const).map(([mint, info, program]) => {
    try {
      return { address: mint, ...checkMeteoraPoolMint(mint, info, program) };
    } catch (error) {
      throw new DexError("UPSTREAM", `This pool's token ${short(mint)} could not be checked on chain: ${error instanceof Error ? error.message : String(error)}.`);
    }
  });
  for (const { address, restrictions } of checked) {
    if (restrictions.length) {
      throw new DexError("TOKEN_RESTRICTED", `This pool's token ${short(address)} ${restrictions.map((r) => RESTRICTION_TEXT[r]).join(" and ")}, so SoFinance can't move it safely. Nothing was built.`);
    }
  }
  return { tokenProgramX, tokenProgramY, decimalsX: checked[0]!.mint.decimals, decimalsY: checked[1]!.mint.decimals };
}

/** Pool (listed + on-chain LbPair) and both mints, one batched read. */
export async function readMeteoraPool(
  deps: Pick<MeteoraOpenDeps, "connection" | "listedPool">, poolId: string, options: { requireListed: boolean } = { requireListed: true },
): Promise<MeteoraPoolState> {
  const poolKey = publicKey(poolId, "pool id");
  // Opening and adding need a listed pool. Withdraw and claim do not (PR6): a pool dropped from the list must never trap funds.
  const listed = options.requireListed ? await deps.listedPool(poolId) : null;
  if (options.requireListed && !listed) throw new DexError("UNSUPPORTED", "This Meteora pool is not on SoFinance's pool list, so it can't be opened here yet.");
  const { context, value: [info] } = await deps.connection.getMultipleAccountsInfoAndContext([poolKey], "confirmed");
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID) throw new DexError("UPSTREAM", "This Meteora pool account was not found on chain.");
  const lbPair = decodeLbPair(info.data);
  const mints = [lbPair.tokenXMint, lbPair.tokenYMint];
  if (listed && (!listed.mints.every((mint) => mints.includes(mint)) || (listed.binStep !== null && listed.binStep !== lbPair.binStep))) {
    throw new DexError("UPSTREAM", "This Meteora pool on chain no longer matches SoFinance's pool list, so nothing was built.");
  }
  if (options.requireListed && lbPair.status !== 0) throw new DexError("UNSUPPORTED", "This Meteora pool is disabled by Meteora right now.");
  const [mintX, mintY] = await deps.connection.getMultipleAccountsInfo([new PublicKey(lbPair.tokenXMint), new PublicKey(lbPair.tokenYMint)], "confirmed");
  const usable = assertMeteoraPoolMintsUsable(lbPair, mintX ?? null, mintY ?? null);
  return { poolId, lbPair, ...usable, slot: context.slot };
}

/** The shared presets on this pool's bin grid, as bin ids (inclusive). The same list `meteoraRequestRange` resolves against. */
export function meteoraOpenPresets(pool: MeteoraPoolState): OpenRangePreset[] {
  const { activeId, binStep } = pool.lbPair;
  return meteoraPresetRanges({
    tickCurrent: activeId * binStep, sqrtPriceX64: binTickSqrtPriceX64(activeId, binStep),
    decimalsA: pool.decimalsX, decimalsB: pool.decimalsY, tickSpacing: binStep,
  }).map((preset) => {
    const lowerUnit = preset.tickLower / binStep, upperUnit = preset.tickUpper / binStep - 1;
    return { id: preset.id, lowerUnit, upperUnit, units: upperUnit - lowerUnit + 1, priceLower: preset.priceLower, priceUpper: preset.priceUpper };
  });
}

/** Bin range of a request: a shared preset on this pool's bin grid, or raw bins. */
export function meteoraRequestRange(request: OpenRequest, pool: MeteoraPoolState): { lowerBinId: number; upperBinId: number } {
  const { range } = request;
  if (range.kind === "units") {
    if (!Number.isInteger(range.lower) || !Number.isInteger(range.upper) || range.upper < range.lower) {
      throw new DexError("INVALID_REQUEST", "The range must be whole bins with the upper bin at or above the lower bin.");
    }
    return { lowerBinId: range.lower, upperBinId: range.upper };
  }
  const preset = meteoraOpenPresets(pool).find((item) => item.id === range.presetId);
  if (!preset) throw new DexError("RANGE_UNSUPPORTED", `The "${range.presetId}" range is not offered for this pool.`);
  return { lowerBinId: preset.lowerUnit, upperBinId: preset.upperUnit };
}

/** Range rules shared by quote and every step: ≤70 bins, existing bin arrays, bitmap extension when needed. */
export async function checkMeteoraOpenRange(connection: Connection, pool: MeteoraPoolState, lowerBinId: number, upperBinId: number) {
  const width = upperBinId - lowerBinId + 1;
  if (width > MAX_OPEN_BINS) {
    throw new DexError("RANGE_UNSUPPORTED", `This range spans ${width} bins, but one Meteora position holds at most ${MAX_OPEN_BINS}, so it's not available to open yet. Pick a narrower range.`);
  }
  const accounts = await readMeteoraOpenAccounts(connection, pool.poolId, lowerBinId, upperBinId);
  if (accounts.missingBinArrayIndexes.length) {
    throw new DexError("NEEDS_NEW_SHARED_ACCOUNT", "This range needs a shared Meteora account (a bin array) that doesn't exist yet. Creating it costs SOL you would not get back, so SoFinance doesn't open it. Pick a range closer to the current price.");
  }
  if (accounts.needsBitmapExtension && !accounts.bitmapExtension) {
    throw new DexError("NEEDS_NEW_SHARED_ACCOUNT", "This range is far from the pool's starting price and needs the pool's bitmap extension account, which doesn't exist yet. Creating it costs SOL you would not get back, so SoFinance doesn't open it.");
  }
  return { width, bitmapExtension: accounts.needsBitmapExtension ? accounts.bitmapExtension : null };
}

function inputProgramFor(pool: MeteoraPoolState, inputMint: string) {
  if (inputMint === pool.lbPair.tokenXMint) return pool.tokenProgramX;
  if (inputMint === pool.lbPair.tokenYMint) return pool.tokenProgramY;
  return SPL_TOKEN_PROGRAM_ID; // USDC
}

export function assertMeteoraOpenInput(request: OpenRequest, pool: MeteoraPoolState) {
  const { token } = request.input;
  if (token === NATIVE_SOL_MINT) {
    throw new DexError("INPUT_TOKEN_UNSUPPORTED", "SOL can't be used to open a Meteora position yet. Use USDC or one of the pool's two tokens.");
  }
  if (![pool.lbPair.tokenXMint, pool.lbPair.tokenYMint, USDC_MINT].includes(token)) {
    throw new DexError("INPUT_TOKEN_UNSUPPORTED", "This token can't be used to open this Meteora position. Use USDC or one of the pool's two tokens.");
  }
  if (!/^\d+$/.test(request.input.amountRaw) || BigInt(request.input.amountRaw) <= 0n) {
    throw new DexError("INVALID_REQUEST", "The deposit amount must be a whole number of the token's smallest units, above zero.");
  }
  if (request.slippageBps !== SLIPPAGE_BPS) {
    throw new DexError("INVALID_REQUEST", `Meteora opens use a fixed ${SLIPPAGE_BPS / 100}% slippage limit; send slippageBps ${SLIPPAGE_BPS}.`);
  }
}

/** Everything quote and both steps share; throws a DexError when the open cannot proceed. */
export async function planMeteoraOpen(
  deps: MeteoraOpenDeps, request: OpenRequest, pool: MeteoraPoolState, range: { lowerBinId: number; upperBinId: number },
  op: "open" | "add" = "open",
): Promise<MeteoraOpenPlan> {
  publicKey(request.owner, "wallet");
  assertMeteoraOpenInput(request, pool);
  const { width, bitmapExtension } = await checkMeteoraOpenRange(deps.connection, pool, range.lowerBinId, range.upperBinId);
  const rent = await fetchMeteoraPositionRent(deps.connection, width);
  const amount = BigInt(request.input.amountRaw);
  const split = meteoraSpotSplit(amount, pool.lbPair.activeId, range.lowerBinId, range.upperBinId);
  const sides = ([
    { side: "x", mint: pool.lbPair.tokenXMint, spend: split.x },
    { side: "y", mint: pool.lbPair.tokenYMint, spend: split.y },
  ] as const).filter((item) => item.spend > 0n).map((item) => ({ ...item, swapped: item.mint !== request.input.token }));
  // The rate comes from the fee policy only. A charging policy with no fee wallet configured throws MISCONFIGURED (and
  // reports to Sentry) in every environment before anything is built: there is no silent 0 fee. Tests / local setups
  // that want no fee pass an explicit "none" policy (`createMeteoraDlmmAdapter({ feePolicy })`).
  // Open and add share one rule shape (swap-input-bps on the swapped part only); each reads its own policy entry.
  const legBps = feeRuleBps(deps.fees.policy[op]);
  assertFeeWalletConfigured({ dexId: meteoraDlmmDescriptor.id, op, charges: legBps > 0, feeWallet: deps.feeConfig().wallet?.toBase58() ?? null });
  const platformFeeRaw = legBps ? sides.filter((s) => s.swapped).reduce((sum, s) => sum + deps.fees.feeFor(op, s.spend), 0n) : 0n;
  return {
    pool, ...range, width, bitmapExtension, positionRentLamports: rent.lamports, amount, inputMint: request.input.token,
    inputProgram: inputProgramFor(pool, request.input.token), sides, legBps, platformFeeRaw,
  };
}

/** A wallet token account a step creates, and its rent (lamports) for that mint's program and extensions. */
export type NewTokenAccount = { mint: string; rentLamports: bigint };

/**
 * Rent of the owner's missing pool-token accounts, per mint: each mint's owner program and extensions are read on chain
 * (a Token-2022 RWA account is 179 bytes, not 165; PR9.2). Shared by the open quote, the setup step's SOL cap, and
 * withdraw / claim / add / compound.
 */
export async function missingPoolTokenAccounts(connection: Connection, pool: MeteoraPoolState, exists: { ataXExists: boolean; ataYExists: boolean }): Promise<NewTokenAccount[]> {
  const mints = [...(exists.ataXExists ? [] : [pool.lbPair.tokenXMint]), ...(exists.ataYExists ? [] : [pool.lbPair.tokenYMint])];
  try {
    return (await associatedTokenAccountRents(connection, mints)).map(({ mint, rentLamports }) => ({ mint, rentLamports }));
  } catch (error) {
    if (error instanceof DexError) throw error;
    throw new DexError("UPSTREAM", `The rent for your new token account could not be read from chain: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const sumRent = (accounts: NewTokenAccount[]) => accounts.reduce((sum, item) => sum + item.rentLamports, 0n);

/**
 * What an open sets aside: the position rent (refunded when the position is closed) and the rent of the wallet token
 * accounts it creates (stays in those accounts). The quote shows exactly these two lines and the setup step caps its
 * simulated SOL debit at their sum plus network fees, so the two cannot disagree.
 */
export type MeteoraOpenRent = { positionLamports: bigint; tokenAccounts: NewTokenAccount[]; tokenAccountLamports: bigint; totalLamports: bigint };

export async function meteoraOpenRent(connection: Connection, plan: MeteoraOpenPlan, exists: { ataXExists: boolean; ataYExists: boolean }): Promise<MeteoraOpenRent> {
  const tokenAccounts = await missingPoolTokenAccounts(connection, plan.pool, exists);
  const tokenAccountLamports = sumRent(tokenAccounts);
  return { positionLamports: plan.positionRentLamports, tokenAccounts, tokenAccountLamports, totalLamports: plan.positionRentLamports + tokenAccountLamports };
}

/** Whether `owner` already holds the pool's two token accounts (the quote has no position key yet). */
export async function ownerPoolTokenAccountsExist(connection: Connection, pool: MeteoraPoolState, owner: string) {
  const wallet = publicKey(owner, "wallet");
  const ataX = getAssociatedTokenAddressSync(new PublicKey(pool.lbPair.tokenXMint), wallet, false, new PublicKey(pool.tokenProgramX));
  const ataY = getAssociatedTokenAddressSync(new PublicKey(pool.lbPair.tokenYMint), wallet, false, new PublicKey(pool.tokenProgramY));
  const [x, y] = await connection.getMultipleAccountsInfo([ataX, ataY], "confirmed");
  return {
    ataXExists: tokenAccount(x ?? null, ataX, wallet, pool.lbPair.tokenXMint, pool.tokenProgramX).exists,
    ataYExists: tokenAccount(y ?? null, ataY, wallet, pool.lbPair.tokenYMint, pool.tokenProgramY).exists,
  };
}

/** Signatures across the two open steps: 1/2 wallet + position, 2/2 wallet. */
export const OPEN_NETWORK_FEE_LAMPORTS = 3n * SIGNATURE_LAMPORTS;

/** The SOL parts of an open; the setup check and the quote (so the dialog) both use this. */
export const meteoraOpenSolParts = (rentLamports: bigint, swapAccountsLamports: bigint): OpenSolParts => ({
  rentLamports, networkFeeLamports: OPEN_NETWORK_FEE_LAMPORTS, swapAccountsLamports, reserveLamports: BigInt(MIN_SOL_LAMPORTS),
});

/** Swap-route temporary accounts a deposit may open and close (Jupiter setup / wrapped SOL). */
const DEPOSIT_INTERMEDIATE_ACCOUNTS = 2n;

/**
 * SOL a deposit's swap legs may hold in temporary token accounts: their mints are not known before routing, so each is
 * priced at the largest account the Associated Token Program can create (every required Token-2022 account extension),
 * at the live rent rate.
 */
export async function depositIntermediateRentAllowance(connection: Connection): Promise<bigint> {
  return DEPOSIT_INTERMEDIATE_ACCOUNTS * BigInt(await connection.getMinimumBalanceForRentExemption(maxAssociatedTokenAccountSpace(), "confirmed"));
}

export type WalletState = {
  walletLamports: bigint;
  ataX: PublicKey; ataY: PublicKey; inputAta: PublicKey;
  ataXExists: boolean; ataYExists: boolean;
  inputBalance: bigint;
  positionInfo: AccountInfo<Buffer> | null;
  slot: number;
};

export function tokenAccount(info: AccountInfo<Buffer> | null, address: PublicKey, owner: PublicKey, mint: string, program: string) {
  if (!info) return { exists: false, amount: 0n };
  if (info.owner.toBase58() !== program) throw new DexError("UPSTREAM", `Your token account ${short(address.toBase58())} is owned by an unexpected program.`);
  const account = unpackAccount(address, info, info.owner);
  if (!account.owner.equals(owner) || account.mint.toBase58() !== mint) throw new DexError("UPSTREAM", `Your token account ${short(address.toBase58())} does not match its owner or token.`);
  if (account.isFrozen) throw new DexError("TOKEN_RESTRICTED", `Your token account for ${short(mint)} is frozen by the token's issuer, so it can't be used.`);
  return { exists: true, amount: account.amount };
}

export async function readWallet(connection: Connection, plan: MeteoraOpenPlan, owner: string, position: string): Promise<WalletState> {
  const wallet = new PublicKey(owner);
  const { lbPair } = plan.pool;
  const ataX = getAssociatedTokenAddressSync(new PublicKey(lbPair.tokenXMint), wallet, false, new PublicKey(plan.pool.tokenProgramX));
  const ataY = getAssociatedTokenAddressSync(new PublicKey(lbPair.tokenYMint), wallet, false, new PublicKey(plan.pool.tokenProgramY));
  const inputAta = getAssociatedTokenAddressSync(new PublicKey(plan.inputMint), wallet, false, new PublicKey(plan.inputProgram));
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([wallet, ataX, ataY, inputAta, new PublicKey(position)], "confirmed");
  const [walletInfo, ataXInfo, ataYInfo, inputInfo, positionInfo] = value;
  const x = tokenAccount(ataXInfo ?? null, ataX, wallet, lbPair.tokenXMint, plan.pool.tokenProgramX);
  const y = tokenAccount(ataYInfo ?? null, ataY, wallet, lbPair.tokenYMint, plan.pool.tokenProgramY);
  const input = tokenAccount(inputInfo ?? null, inputAta, wallet, plan.inputMint, plan.inputProgram);
  return {
    walletLamports: BigInt(walletInfo?.lamports ?? 0), ataX, ataY, inputAta, ataXExists: x.exists, ataYExists: y.exists,
    inputBalance: input.amount, positionInfo: positionInfo ?? null, slot: context.slot,
  };
}

function assertInputBalance(plan: MeteoraOpenPlan, state: WalletState) {
  if (state.inputBalance < plan.amount) {
    throw new DexError("INSUFFICIENT_FUNDS", `Your wallet holds ${state.inputBalance} raw units of the input token but this deposit needs ${plan.amount}. Lower the amount or add more.`);
  }
}

export const cuLimit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
export const compileV0 = (payer: PublicKey, blockhash: string, instructions: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());

export async function simulate(connection: Connection, transaction: VersionedTransaction, addresses: PublicKey[], minContextSlot: number, what: string) {
  const result = await withContextSlotRetry(() => connection.simulateTransaction(transaction, {
    sigVerify: false, commitment: "confirmed", minContextSlot, accounts: { encoding: "base64", addresses: addresses.map((a) => a.toBase58()) },
  }));
  if (result.value.err) {
    throw new DexError("UPSTREAM", `The ${what} transaction failed in simulation, so nothing was sent: ${JSON.stringify(result.value.err)}; ${result.value.logs?.slice(-4).join(" | ") || "no logs"}`);
  }
  return result.value;
}

export const accountData = (account: { data: string[] } | null | undefined) => (account?.data?.[0] ? Buffer.from(account.data[0], "base64") : null);

function setupInstructions(plan: MeteoraOpenPlan, state: WalletState, owner: string, position: string, units = ATOMIC_COMPUTE_UNIT_LIMIT) {
  const wallet = new PublicKey(owner);
  const { lbPair, tokenProgramX, tokenProgramY } = plan.pool;
  return [
    cuLimit(units),
    ...(state.ataXExists ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, state.ataX, wallet, new PublicKey(lbPair.tokenXMint), new PublicKey(tokenProgramX))]),
    ...(state.ataYExists ? [] : [createAssociatedTokenAccountIdempotentInstruction(wallet, state.ataY, wallet, new PublicKey(lbPair.tokenYMint), new PublicKey(tokenProgramY))]),
    meteoraInitializePositionInstruction({
      payer: wallet, position: new PublicKey(position), lbPair: new PublicKey(plan.pool.poolId), owner: wallet,
      lowerBinId: plan.lowerBinId, width: plan.width,
    }),
  ];
}

async function swapLegs(plan: MeteoraOpenPlan, owner: string, constraints: JupiterRouteConstraints) {
  const legs = await Promise.all(plan.sides.map(async (side) => {
    if (!side.swapped) return { side: side.side, minOut: side.spend, route: null as BuildRoute | null };
    const leg = await feeSwapLeg({
      wallet: owner, inputMint: plan.inputMint, outputMint: side.mint, spend: side.spend, feeBps: plan.legBps,
      inputFee: plan.legBps > 0, build: true, constraints,
    });
    if (plan.legBps > 0 && (!leg.feeInRoute || leg.feeAmount <= 0n)) {
      throw new DexError("UPSTREAM", "The platform fee could not be collected inside the Jupiter swap, so nothing was built.");
    }
    return { side: side.side, minOut: leg.minOut, route: leg.route as BuildRoute | null };
  }));
  return {
    amountX: legs.filter((l) => l.side === "x").reduce((sum, l) => sum + l.minOut, 0n),
    amountY: legs.filter((l) => l.side === "y").reduce((sum, l) => sum + l.minOut, 0n),
    routes: legs.flatMap((l) => (l.route ? [l.route] : [])),
  };
}

export function addInstruction(plan: MeteoraOpenPlan, state: WalletState, owner: string, position: string, amountX: bigint, amountY: bigint) {
  const { lbPair } = plan.pool;
  return meteoraAddLiquidityByStrategy2Instruction({
    position: new PublicKey(position), lbPair: new PublicKey(plan.pool.poolId), sender: new PublicKey(owner),
    userTokenX: state.ataX, userTokenY: state.ataY, reserveX: new PublicKey(lbPair.reserveX), reserveY: new PublicKey(lbPair.reserveY),
    tokenXMint: new PublicKey(lbPair.tokenXMint), tokenYMint: new PublicKey(lbPair.tokenYMint),
    tokenXProgram: new PublicKey(plan.pool.tokenProgramX), tokenYProgram: new PublicKey(plan.pool.tokenProgramY),
    amountX, amountY, activeId: lbPair.activeId, maxActiveBinSlippage: meteoraMaxActiveBinSlippage(SLIPPAGE_BPS, lbPair.binStep),
    minBinId: plan.lowerBinId, maxBinId: plan.upperBinId, ...(plan.bitmapExtension ? { bitmapExtension: plan.bitmapExtension } : {}),
  });
}

/** Assembles 2/2. `compactAtas`: drop Jupiter ATA creates for accounts that already exist (once 1/2 has landed). */
export async function compileDeposit(deps: MeteoraOpenDeps, plan: MeteoraOpenPlan, state: WalletState, owner: string, position: string, blockhash: string, compactAtas: boolean,
  prefix: TransactionInstruction[] = []) {
  let lastError: unknown;
  const lookupTables = openLookupTableReader(deps.connection);
  const wallet = new PublicKey(owner);
  for (const constraints of JUPITER_ROUTE_ATTEMPTS) {
    const legs = await swapLegs(plan, owner, constraints);
    const body = [...prefix, ...swapRouteInstructions(legs.routes, wallet), addInstruction(plan, state, owner, position, legs.amountX, legs.amountY)];
    const instructions = compactAtas ? await compactAtaInstructions(deps.connection, [cuLimit(ATOMIC_COMPUTE_UNIT_LIMIT), ...body]) : [cuLimit(ATOMIC_COMPUTE_UNIT_LIMIT), ...body];
    assertMeteoraFeeRule(instructions, deps.feeConfig());
    const tables = await lookupTables(legs.routes.flatMap((route) => Object.keys(route.addressesByLookupTableAddress ?? {}).map((key) => new PublicKey(key))));
    const compiled = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: blockhash, instructions }, tables);
    try {
      assertOpenTransactionSize(compiled.transaction);
      return { instructions, tables: compiled.tables, transaction: compiled.transaction };
    } catch (error) {
      lastError = error;
      if (!isTxOversizeError(error) || legs.routes.length === 0) throw error;
    }
  }
  throw lastError;
}

export type BuiltStep = { transaction: string; lastValidBlockHeight: number };
export type MeteoraSetupBuilt = BuiltStep & { rent: MeteoraOpenRent };
export const encode = (transaction: VersionedTransaction) => Buffer.from(transaction.serialize()).toString("base64");

/** 1/2: the wallet's own ATAs + initialize_position, simulated; 2/2 is drafted first so rent is never paid for a dead end. */
export async function buildMeteoraSetup(deps: MeteoraOpenDeps, plan: MeteoraOpenPlan, owner: string, position: string): Promise<MeteoraSetupBuilt> {
  const { connection } = deps;
  const state = await readWallet(connection, plan, owner, position);
  if (state.positionInfo) throw new DexError("INVALID_REQUEST", "That position key is already in use on chain. Start the open again so a fresh one is created.");
  assertInputBalance(plan, state);
  const wallet = new PublicKey(owner);
  const [rent, allowance, latest] = await Promise.all([
    meteoraOpenRent(connection, plan, state), depositIntermediateRentAllowance(connection), connection.getLatestBlockhash("confirmed"),
  ]);
  await compileDeposit(deps, plan, state, owner, position, latest.blockhash, false);
  const required = openSolNeed(meteoraOpenSolParts(rent.totalLamports, allowance));
  if (state.walletLamports < required) {
    throw new DexError("INSUFFICIENT_FUNDS", `Not enough SOL: this open needs about ${sol(required)} SOL (position rent ${sol(plan.positionRentLamports)} SOL, refunded when you fully withdraw, plus ${sol(rent.tokenAccountLamports)} SOL for new token accounts, ${sol(allowance)} SOL for temporary swap accounts, network fees and a ${sol(BigInt(MIN_SOL_LAMPORTS))} SOL reserve), and your wallet has ${sol(state.walletLamports)} SOL. Add about ${sol(required - state.walletLamports)} SOL to open. Your wallet may also add a priority fee to each step, which must fit in your SOL.`);
  }
  const instructions = setupInstructions(plan, state, owner, position);
  assertMeteoraFeeRule(instructions, deps.feeConfig());
  const sim = await simulate(connection, compileV0(wallet, latest.blockhash, instructions), [new PublicKey(position), wallet], state.slot, "position setup");
  const after = accountData(sim.accounts?.[0]);
  if (!after || sim.accounts?.[0]?.owner !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(after)) {
    throw new DexError("UPSTREAM", "The setup simulation did not create the Meteora position account, so nothing was sent.");
  }
  const created = decodeMeteoraPosition(after);
  if (created.owner !== owner || created.lbPair !== plan.pool.poolId || created.lowerBinId !== plan.lowerBinId || created.upperBinId !== plan.upperBinId) {
    throw new DexError("UPSTREAM", "The simulated position does not match your wallet, pool or range, so nothing was sent.");
  }
  const solDebit = state.walletLamports - BigInt(sim.accounts?.[1]?.lamports ?? 0);
  if (solDebit > rent.totalLamports + OPEN_NETWORK_FEE_LAMPORTS) throw new DexError("UPSTREAM", "The setup simulation spends more SOL than the rent and fees shown, so nothing was sent.");
  const final = setupInstructions(plan, state, owner, position, measuredComputeUnitLimit(sim.unitsConsumed ?? 0));
  const transaction = compileV0(wallet, latest.blockhash, final);
  assertOpenTransactionSize(transaction);
  return { transaction: encode(transaction), lastValidBlockHeight: latest.lastValidBlockHeight, rent };
}

/** Reads the position 1/2 created: a Meteora position owned by `owner` in `poolId`, still empty. */
export function assertEmptyOwnedPosition(info: AccountInfo<Buffer> | null, owner: string | null, poolId: string | null): MeteoraPosition {
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) {
    throw new DexError("POSITION_NOT_FOUND", "The Meteora position account was not found on chain. If you just ran step 1 of 2, wait a few seconds for it to confirm and try again.");
  }
  const position = decodeMeteoraPosition(info.data);
  if ((owner !== null && position.owner !== owner) || (poolId !== null && position.lbPair !== poolId)) {
    throw new DexError("POSITION_NOT_FOUND", "That Meteora position belongs to another wallet or pool.");
  }
  if (meteoraPositionLiquidity(position) !== 0n) throw new DexError("INVALID_REQUEST", "That Meteora position already holds liquidity, so it is not a half-finished open.");
  return position;
}

/** 2/2: swap legs + add_liquidity_by_strategy2 into the position 1/2 created, simulated against it. */
export async function buildMeteoraDeposit(deps: MeteoraOpenDeps, plan: MeteoraOpenPlan, owner: string, position: string): Promise<BuiltStep> {
  const { connection } = deps;
  const state = await readWallet(connection, plan, owner, position);
  assertEmptyOwnedPosition(state.positionInfo, owner, plan.pool.poolId);
  assertInputBalance(plan, state);
  if (!state.ataXExists || !state.ataYExists) throw new DexError("POSITION_NOT_FOUND", "Your pool token accounts from step 1 of 2 are missing. Wait for step 1 to confirm and try again.");
  const allowance = await depositIntermediateRentAllowance(connection);
  const depositNeed = allowance + SIGNATURE_LAMPORTS;
  if (state.walletLamports < depositNeed) {
    throw new DexError("INSUFFICIENT_FUNDS", `Not enough SOL to finish step 2 of 2: add about ${sol(depositNeed - state.walletLamports)} SOL, or close the empty position to get its rent back.`);
  }
  const wallet = new PublicKey(owner);
  const latest = await connection.getLatestBlockhash("confirmed");
  const built = await compileDeposit(deps, plan, state, owner, position, latest.blockhash, true);
  const positionKey = new PublicKey(position);
  const sim = await simulate(connection, built.transaction, [positionKey, wallet, state.inputAta], state.slot, "deposit");
  const after = accountData(sim.accounts?.[0]);
  if (!after || !isMeteoraPositionAccount(after) || meteoraPositionLiquidity(decodeMeteoraPosition(after)) <= 0n) {
    throw new DexError("UPSTREAM", "The deposit simulation added no liquidity to the position, so nothing was sent.");
  }
  const solDebit = state.walletLamports - BigInt(sim.accounts?.[1]?.lamports ?? 0);
  if (solDebit > allowance) throw new DexError("UPSTREAM", "The deposit simulation spends more SOL than allowed, so nothing was sent.");
  const inputAfter = accountData(sim.accounts?.[2]);
  const inputProgram = new PublicKey(plan.inputProgram);
  const remaining = inputAfter ? unpackAccount(state.inputAta, { data: inputAfter, owner: inputProgram, lamports: 0, executable: false }, inputProgram).amount : 0n;
  if (state.inputBalance - remaining > plan.amount) throw new DexError("UPSTREAM", "The deposit simulation spends more of your token than requested, so nothing was sent.");
  const instructions = built.instructions.map((ix, index) => (index === 0 ? cuLimit(measuredComputeUnitLimit(sim.unitsConsumed ?? 0)) : ix));
  assertMeteoraFeeRule(instructions, deps.feeConfig());
  const transaction = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: latest.blockhash, instructions }, built.tables).transaction;
  assertOpenTransactionSize(transaction);
  return { transaction: encode(transaction), lastValidBlockHeight: latest.lastValidBlockHeight };
}

/**
 * Recovery: close an empty position (2/2 failed or was abandoned) with close_position2. Only the requesting wallet's own
 * position, only when it holds no liquidity, and the rent goes back to that wallet (sender = rent receiver = owner).
 */
export async function buildMeteoraCloseRefund(deps: Pick<MeteoraOpenDeps, "connection" | "feeConfig">, position: string, owner: string): Promise<BuiltStep & { owner: string; refundLamports: bigint }> {
  const { connection } = deps;
  const positionKey = publicKey(position, "position");
  const wallet = publicKey(owner, "wallet");
  const { context, value: [info] } = await connection.getMultipleAccountsInfoAndContext([positionKey], "confirmed");
  // The adapter checks ownership itself (not only the route): MCP and other callers reach prepareRecovery directly.
  const decoded = assertEmptyOwnedPosition(info ?? null, wallet.toBase58(), null);
  if (decoded.owner !== wallet.toBase58()) throw new DexError("POSITION_NOT_FOUND", "That Meteora position belongs to another wallet.");
  const walletInfo = await connection.getAccountInfo(wallet, "confirmed");
  const latest = await connection.getLatestBlockhash("confirmed");
  const close = (units: number) => [cuLimit(units), meteoraClosePosition2Instruction({ position: positionKey, sender: wallet, rentReceiver: wallet })];
  assertMeteoraFeeRule(close(200_000), deps.feeConfig());
  const sim = await simulate(connection, compileV0(wallet, latest.blockhash, close(200_000)), [positionKey, wallet], context.slot, "close");
  const refund = BigInt(sim.accounts?.[1]?.lamports ?? 0) - BigInt(walletInfo?.lamports ?? 0);
  if (refund <= 0n) throw new DexError("UPSTREAM", "The close simulation did not return the position rent, so nothing was sent.");
  const transaction = compileV0(wallet, latest.blockhash, close(measuredComputeUnitLimit(sim.unitsConsumed ?? 0)));
  assertOpenTransactionSize(transaction);
  return { transaction: encode(transaction), lastValidBlockHeight: latest.lastValidBlockHeight, owner: decoded.owner, refundLamports: refund };
}
