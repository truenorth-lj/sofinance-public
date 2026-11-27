import { createHash } from "node:crypto";
import { getPdaExBitmapAccount, MEMO_PROGRAM_ID, PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { MAX_U64, sizeCompoundLiquidity } from "./compound-math";
import type { CompoundAccount, CompoundPositionState } from "./compound-types";

export type CompoundSwap = {
  inputMint: string; outputMint: string; inputAmount: string;
  quotedOutputAmount: string; minOutputAmount: string;
  inputDecimals: number; outputDecimals: number; poolId: string; sqrtPriceAfterX64: string;
  feeBps: number; feeAmount: string;
  poolFeeAmount?: string;
};
export type CompoundSwapQuote = { output: bigint; sqrtPriceX64: bigint };
type Direction = "a-to-b" | "b-to-a";
type SwapContext = {
  price: bigint; lower: bigint; upper: bigint; amountA: bigint; amountB: bigint;
  startingLiquidity?: bigint; quote: (direction: Direction, input: bigint) => CompoundSwapQuote;
};
function ratioDifference(price: bigint, lower: bigint, upper: bigint, a: bigint, b: bigint) {
  const p = price < lower ? lower : price > upper ? upper : price;
  return a * (p - lower) * upper * p - b * (1n << 128n) * (upper - p);
}

/** Find the crossing of available and required token ratios at the price AFTER
 * swapping. This also handles a swap that moves an outside position in range.
 * Only the isolated harvested balances are available to this search. */
export function optimizeCompoundSwap(input: SwapContext) {
  const { price, lower, upper, amountA, amountB, startingLiquidity = 0n, quote } = input;
  const baseline = sizeCompoundLiquidity(price, lower, upper, amountA, amountB, startingLiquidity);
  const initialDifference = ratioDifference(price, lower, upper, amountA, amountB);
  const empty = { direction: null, input: 0n, output: 0n, sqrtPriceX64: price,
    balances: { a: amountA, b: amountB }, sized: baseline };
  if (initialDifference === 0n) return empty;
  const direction: Direction = initialDifference > 0n ? "a-to-b" : "b-to-a";
  const budget = direction === "a-to-b" ? amountA : amountB;
  const cache = new Map<bigint, ReturnType<typeof evaluate>>();
  function evaluate(amount: bigint) {
    const q = amount === 0n ? { output: 0n, sqrtPriceX64: price } : quote(direction, amount);
    if (q.output < 0n || q.output > MAX_U64 || q.sqrtPriceX64 <= 0n) throw new Error("Invalid harvest swap quote");
    const a = direction === "a-to-b" ? amountA - amount : amountA + q.output;
    const b = direction === "a-to-b" ? amountB + q.output : amountB - amount;
    const difference = ratioDifference(q.sqrtPriceX64, lower, upper, a, b);
    return { direction, input: amount, output: q.output, sqrtPriceX64: q.sqrtPriceX64,
      balances: { a, b }, difference,
      sized: sizeCompoundLiquidity(q.sqrtPriceX64, lower, upper, a, b, startingLiquidity) };
  }
  const get = (amount: bigint) => {
    let result = cache.get(amount);
    if (!result) { result = evaluate(amount); cache.set(amount, result); }
    return result;
  };
  let low = 0n, high = budget;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const result = get(mid);
    const stillExcess = direction === "a-to-b" ? result.difference >= 0n : result.difference <= 0n;
    if (stillExcess) low = mid;
    else high = mid - 1n;
  }
  // Integer rounding can put the optimum on either side of the crossing.
  const candidates = [...new Set([low, ...(low < budget ? [low + 1n] : []), 0n])].map(get);
  const best = candidates.reduce((chosen, candidate) => candidate.sized.liquidity > chosen.sized.liquidity ||
    candidate.sized.liquidity === chosen.sized.liquidity && candidate.input < chosen.input ? candidate : chosen);
  if (best.input === 0n) {
    // A positive balance on the unusable side must not silently become a
    // reported successful full compound when no protected swap can use it.
    if (baseline.liquidity === 0n && budget > 0n) throw new Error("After harvest swap still cannot form reinvestable liquidity");
    return empty;
  }
  if (best.output === 0n) throw new Error("Harvest swap below minimum output unit, cannot protect full reinvestment");
  return best;
}

export type CompoundSwapShape = {
  state: CompoundPositionState; accounts: [CompoundAccount, CompoundAccount];
  swap: CompoundSwap; config: string; observation: string; tickArrays: string[];
  /** observation_id decoded from the on-chain CLMM pool account, or null if that read or decode failed. */
  onChainObservation: string | null;
};

/** Decode observation_id from a fetched CLMM pool account. Null if missing, wrong owner, or undecodable. */
export function decodeOnChainPoolObservation(
  account: { owner: PublicKey; data: Uint8Array } | null, programId: string,
): string | null {
  if (!account || account.owner.toBase58() !== programId) return null;
  try {
    const observationId = PoolInfoLayout.decode(Buffer.from(account.data)).observationId;
    if (!(observationId instanceof PublicKey)) return null;
    const encoded = observationId.toBase58();
    return encoded === PublicKey.default.toBase58() ? null : encoded;
  } catch {
    return null;
  }
}

/** Stable codes for each check in validateCompoundSwapInstruction. Order matches the original short-circuit. */
export const COMPOUND_SWAP_GUARD_CODES = [
  "pool_mismatch", "input_mint_mismatch", "output_mint_mismatch", "input_amount_invalid",
  "min_output_invalid", "quoted_output_invalid", "account_mint_mismatch", "isolated_account_is_ata",
  "isolated_accounts_equal", "tick_arrays_empty", "tick_arrays_duplicate", "observation_unreadable", "observation_mismatch",
  "program_mismatch", "data_length_mismatch", "discriminator_mismatch", "input_amount_data_mismatch",
  "min_output_data_mismatch", "price_limit_nonzero", "not_base_input", "key_count_mismatch",
  "account_pubkey_mismatch", "account_signer_mismatch", "account_writable_mismatch",
] as const;
export type CompoundSwapGuardCode = typeof COMPOUND_SWAP_GUARD_CODES[number];

/** Fixed public sentences. No accounts, RPC URLs, or other secrets. */
export const COMPOUND_SWAP_GUARD_MESSAGES = {
  pool_mismatch: "Compound swap pool mismatch",
  input_mint_mismatch: "Compound swap input mint mismatch",
  output_mint_mismatch: "Compound swap output mint mismatch",
  input_amount_invalid: "Compound swap input amount invalid",
  min_output_invalid: "Compound swap minOutput invalid",
  quoted_output_invalid: "Compound swap quoted output invalid",
  account_mint_mismatch: "Compound swap account mint mismatch",
  isolated_account_is_ata: "Compound swap isolated account is a wallet ATA",
  isolated_accounts_equal: "Compound swap isolated accounts are the same",
  tick_arrays_empty: "Compound swap tick arrays empty",
  tick_arrays_duplicate: "Compound swap tick arrays duplicate",
  observation_unreadable: "Compound swap on-chain observation unreadable",
  observation_mismatch: "Compound swap observation mismatch",
  program_mismatch: "Compound swap program mismatch",
  data_length_mismatch: "Compound swap data length mismatch",
  discriminator_mismatch: "Compound swap discriminator mismatch",
  input_amount_data_mismatch: "Compound swap input amount data mismatch",
  min_output_data_mismatch: "Compound swap minOutput data mismatch",
  price_limit_nonzero: "Compound swap price limit is not zero",
  not_base_input: "Compound swap is not base-input",
  key_count_mismatch: "Compound swap key count mismatch",
  account_pubkey_mismatch: "Compound swap account pubkey mismatch",
  account_signer_mismatch: "Compound swap account signer mismatch",
  account_writable_mismatch: "Compound swap account writable mismatch",
} as const satisfies Record<CompoundSwapGuardCode, string>;

export class CompoundSwapGuardError extends Error {
  readonly code: CompoundSwapGuardCode;
  constructor(code: CompoundSwapGuardCode) {
    super(COMPOUND_SWAP_GUARD_MESSAGES[code]);
    this.name = "CompoundSwapGuardError";
    this.code = code;
  }
}

function fail(code: CompoundSwapGuardCode): never {
  throw new CompoundSwapGuardError(code);
}

/** Validate every account and privilege independently of the SDK's builder.
 * The caller supplies tick arrays whose ownership/pool/PDA were read on chain.
 * Observation is accepted only when it equals the on-chain pool observation_id. */
export function validateCompoundSwapInstruction(ix: TransactionInstruction, shape: CompoundSwapShape) {
  const { state, accounts, swap, config, observation, onChainObservation, tickArrays } = shape;
  const inputA = swap.inputMint === state.mintA;
  const inputIndex = inputA ? 0 : 1, outputIndex = inputA ? 1 : 0;
  const inputAmount = BigInt(swap.inputAmount), minOutput = BigInt(swap.minOutputAmount), quotedOutput = BigInt(swap.quotedOutputAmount);
  const expected = [state.wallet, config, state.poolId, accounts[inputIndex].address, accounts[outputIndex].address,
    inputA ? state.vaultA : state.vaultB, inputA ? state.vaultB : state.vaultA, observation,
    TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), MEMO_PROGRAM_ID.toBase58(),
    swap.inputMint, swap.outputMint,
    getPdaExBitmapAccount(new PublicKey(state.programId), new PublicKey(state.poolId)).publicKey.toBase58(), ...tickArrays];
  // Thunks so later reads (u64 at offsets 8 and 16, byte 40) never
  // run unless every earlier check passed — same short-circuit as the original `||`.
  const checks: readonly [check: () => boolean, code: CompoundSwapGuardCode][] = [
    [() => swap.poolId !== state.poolId, "pool_mismatch"],
    [() => ![state.mintA, state.mintB].includes(swap.inputMint), "input_mint_mismatch"],
    [() => swap.outputMint !== (inputA ? state.mintB : state.mintA), "output_mint_mismatch"],
    [() => inputAmount <= 0n || inputAmount > MAX_U64, "input_amount_invalid"],
    [() => minOutput <= 0n || minOutput > quotedOutput, "min_output_invalid"],
    [() => quotedOutput > MAX_U64, "quoted_output_invalid"],
    [() => accounts[0].mint !== state.mintA || accounts[1].mint !== state.mintB, "account_mint_mismatch"],
    [() => accounts.some((account) => [state.ataA, state.ataB].includes(account.address)), "isolated_account_is_ata"],
    [() => accounts[0].address === accounts[1].address, "isolated_accounts_equal"],
    [() => tickArrays.length === 0, "tick_arrays_empty"],
    [() => new Set(tickArrays).size !== tickArrays.length, "tick_arrays_duplicate"],
    [() => onChainObservation === null, "observation_unreadable"],
    [() => observation !== onChainObservation, "observation_mismatch"],
    [() => ix.programId.toBase58() !== state.programId, "program_mismatch"],
    [() => ix.data.length !== 41, "data_length_mismatch"],
    [() => !ix.data.subarray(0, 8).equals(createHash("sha256").update("global:swap_v2").digest().subarray(0, 8)), "discriminator_mismatch"],
    [() => ix.data.readBigUInt64LE(8) !== inputAmount, "input_amount_data_mismatch"],
    [() => ix.data.readBigUInt64LE(16) !== minOutput, "min_output_data_mismatch"],
    [() => ix.data.subarray(24, 40).some((byte) => byte !== 0), "price_limit_nonzero"],
    [() => ix.data[40] !== 1, "not_base_input"],
    [() => ix.keys.length !== expected.length, "key_count_mismatch"],
  ];
  for (const [check, code] of checks) if (check()) fail(code);
  const writable = new Set([2, 3, 4, 5, 6, 7, ...expected.slice(13).map((_, index) => index + 13)]);
  ix.keys.forEach((key, index) => {
    if (key.pubkey.toBase58() !== expected[index]) fail("account_pubkey_mismatch");
    if (key.isSigner !== (index === 0)) fail("account_signer_mismatch");
    if (key.isWritable !== writable.has(index)) fail("account_writable_mismatch");
  });
}
