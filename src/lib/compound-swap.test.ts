import BN from "bn.js";
import { ClmmInstrument, getPdaExBitmapAccount, getPdaObservationAccount, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { COMPOUND_SWAP_GUARD_CODES, COMPOUND_SWAP_GUARD_MESSAGES, CompoundSwapGuardError, optimizeCompoundSwap, validateCompoundSwapInstruction, type CompoundSwap, type CompoundSwapGuardCode, type CompoundSwapShape } from "@sofinance/engine/compound-swap";
import { MAX_U64, sizeCompoundLiquidity } from "@sofinance/engine/compound-math";
import { computeSwapFee, netSwapInput } from "@sofinance/engine/swap/fee";
import type { CompoundAccount, CompoundPositionState } from "@sofinance/engine/compound-types";

const q = 1n << 64n;
const quoteAt = (price: bigint) => (_direction: string, input: bigint) => ({ output: input, sqrtPriceX64: price });
it("converts all of the unusable yield while the original position stays outside", () => {
  const below = optimizeCompoundSwap({ price: q / 3n, lower: q / 2n, upper: q * 2n, amountA: 0n, amountB: 100n, quote: quoteAt(q / 3n) });
  expect(below.direction).toBe("b-to-a");
  expect(below.input).toBe(100n);
  expect(below.balances).toEqual({ a: 100n, b: 0n });
  expect(below.sized.liquidity).toBeGreaterThan(0n);
  const above = optimizeCompoundSwap({ price: q * 3n, lower: q / 2n, upper: q * 2n, amountA: 100n, amountB: 0n, quote: quoteAt(q * 3n) });
  expect(above.direction).toBe("a-to-b");
  expect(above.input).toBe(100n);
  expect(above.balances).toEqual({ a: 0n, b: 100n });
});
it("balances asymmetric rewards to the range's actual ratio instead of a fixed half", () => {
  const price = q * 3n / 4n;
  const result = optimizeCompoundSwap({ price, lower: q / 2n, upper: q * 2n, amountA: 1_000n, amountB: 0n, quote: quoteAt(price) });
  expect(result.direction).toBe("a-to-b");
  expect(result.input).not.toBe(500n);
  let maximum = 0n;
  for (let input = 0n; input <= 1_000n; input++) maximum = maximum > sizeCompoundLiquidity(price, q / 2n, q * 2n, 1_000n - input, input).liquidity ? maximum : sizeCompoundLiquidity(price, q / 2n, q * 2n, 1_000n - input, input).liquidity;
  expect(result.sized.liquidity).toBe(maximum);
});
it("uses the post-swap price when the swap itself brings an outside position inside", () => {
  const quote = (_direction: string, input: bigint) => ({ output: input, sqrtPriceX64: q / 3n + input * q / 100n });
  const result = optimizeCompoundSwap({ price: q / 3n, lower: q / 2n, upper: q * 2n, amountA: 0n, amountB: 100n, quote });
  expect(result.direction).toBe("b-to-a");
  expect(result.input).toBeGreaterThan(0n);
  expect(result.input).toBeLessThan(100n);
  expect(result.sqrtPriceX64).toBeGreaterThan(q / 2n);
  let maximum = 0n;
  for (let input = 0n; input <= 100n; input++) {
    const liquidity = sizeCompoundLiquidity(quote("b-to-a", input).sqrtPriceX64, q / 2n, q * 2n, input, 100n - input).liquidity;
    if (liquidity > maximum) maximum = liquidity;
  }
  expect(result.sized.liquidity).toBe(maximum);
});
it("leaves balanced yields unchanged and bounds every quote by the harvested source", () => {
  const unused = vi.fn(quoteAt(q));
  expect(optimizeCompoundSwap({ price: q, lower: q / 2n, upper: q * 2n, amountA: 100n, amountB: 100n, quote: unused }).direction).toBeNull();
  expect(unused).not.toHaveBeenCalled();
  const bounded = vi.fn((direction: string, input: bigint) => {
    expect(direction).toBe("a-to-b"); expect(input).toBeGreaterThan(0n); expect(input).toBeLessThanOrEqual(101n);
    return { output: input, sqrtPriceX64: q };
  });
  const result = optimizeCompoundSwap({ price: q, lower: q / 2n, upper: q * 2n, amountA: 101n, amountB: 0n, quote: bounded });
  expect(result.sized.a <= result.balances.a && result.sized.b <= result.balances.b).toBe(true);
});
it("sizes the rebalance using net output after the protocol fee is reserved from the swap input", () => {
  const price = q;
  const bps = 10;
  const quote = (_direction: string, input: bigint) => {
    const { swapAmount } = netSwapInput(input, bps);
    return { output: swapAmount, sqrtPriceX64: price };
  };
  const result = optimizeCompoundSwap({ price, lower: q / 2n, upper: q * 2n, amountA: 10_000n, amountB: 0n, quote });
  expect(result.direction).toBe("a-to-b");
  expect(result.input).toBeGreaterThan(0n);
  expect(result.output).toBe(result.input - computeSwapFee(result.input, bps));
  expect(result.balances.a + result.balances.b).toBe(10_000n - computeSwapFee(result.input, bps));
});
it("fails when the opposite-side yield cannot produce protected output, without a profitability gate", () => {
  expect(() => optimizeCompoundSwap({ price: q / 3n, lower: q / 2n, upper: q * 2n, amountA: 0n, amountB: 1n,
    quote: () => ({ output: 0n, sqrtPriceX64: q / 3n }) })).toThrow("cannot form");
  const tiny = optimizeCompoundSwap({ price: q / 3n, lower: q / 2n, upper: q * 2n, amountA: 0n, amountB: 2n, quote: quoteAt(q / 3n) });
  expect(tiny.input).toBe(2n);
  expect(tiny.sized.liquidity).toBeGreaterThan(0n);
});

const key = () => Keypair.generate().publicKey.toBase58();
function fixture() {
  const state = { wallet: key(), poolId: key(), programId: key(), mintA: key(), mintB: key(), vaultA: key(), vaultB: key(),
    ataA: key(), ataB: key() } as CompoundPositionState;
  const accounts = [{ address: key(), mint: state.mintA, program: TOKEN_PROGRAM_ID.toBase58() },
    { address: key(), mint: state.mintB, program: TOKEN_PROGRAM_ID.toBase58() }] as [CompoundAccount, CompoundAccount];
  const pub = (value: string) => new PublicKey(value), program = pub(state.programId), pool = pub(state.poolId);
  const config = key();
  const observation = getPdaObservationAccount(program, pool).publicKey.toBase58();
  const tickArrays = [getPdaTickArrayAddress(program, pool, 0).publicKey.toBase58()];
  const swap: CompoundSwap = { inputMint: state.mintB, outputMint: state.mintA, inputAmount: "100", quotedOutputAmount: "90",
    minOutputAmount: "89", inputDecimals: 6, outputDecimals: 6, poolId: state.poolId, sqrtPriceAfterX64: q.toString(),
    feeBps: 0, feeAmount: "0" };
  const ix = ClmmInstrument.swapV2Instruction(program, pub(state.wallet), pool, pub(config), pub(accounts[1].address), pub(accounts[0].address),
    pub(state.vaultB), pub(state.vaultA), pub(state.mintB), pub(state.mintA), tickArrays.map(pub), pub(observation), new BN(100), new BN(89), new BN(0), true,
    getPdaExBitmapAccount(program, pool).publicKey);
  const shape: CompoundSwapShape = { state, accounts, swap, config, observation, tickArrays };
  return { ix, shape, validate: () => validateCompoundSwapInstruction(ix, shape) };
}
it("accepts exact SDK same-pool swap with two isolated sources and one wallet signer", () => {
  expect(() => fixture().validate()).not.toThrow();
});
function expectCode(run: () => void, code: CompoundSwapGuardCode) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CompoundSwapGuardError);
    expect((error as CompoundSwapGuardError).code).toBe(code);
    expect((error as CompoundSwapGuardError).message).toBe(COMPOUND_SWAP_GUARD_MESSAGES[code]);
    expect((error as CompoundSwapGuardError).message).toMatch(/^Compound swap /);
    expect((error as CompoundSwapGuardError).message).not.toMatch(/https?:\/\/|rpc|api[_-]?key|secret|authorization/i);
    return;
  }
  throw new Error(`expected ${code}`);
}

it("rejects ordinary wallet ATA sources, unknown ticks/vaults, and any account privilege changes", () => {
  const source = fixture(); source.ix.keys[3]!.pubkey = new PublicKey(source.shape.state.ataB);
  expectCode(source.validate, "account_pubkey_mismatch");
  const tick = fixture(); tick.ix.keys[14]!.pubkey = Keypair.generate().publicKey;
  expectCode(tick.validate, "account_pubkey_mismatch");
  const vault = fixture(); vault.ix.keys[5]!.pubkey = Keypair.generate().publicKey;
  expectCode(vault.validate, "account_pubkey_mismatch");
  const mint = fixture(); mint.ix.keys[11]!.isWritable = true;
  expectCode(mint.validate, "account_writable_mismatch");
  const signer = fixture(); signer.ix.keys[4]!.isSigner = true;
  expectCode(signer.validate, "account_signer_mismatch");
});
it("rejects input or slippage caps, program, exact-output mode and price-limit tampering", () => {
  const inputData = fixture(); inputData.ix.data.writeBigUInt64LE(101n, 8);
  expectCode(inputData.validate, "input_amount_data_mismatch");
  const minData = fixture(); minData.ix.data.writeBigUInt64LE(0n, 16);
  expectCode(minData.validate, "min_output_data_mismatch");
  const limit = fixture(); limit.ix.data.writeBigUInt64LE(1n, 24);
  expectCode(limit.validate, "price_limit_nonzero");
  const program = fixture(); program.ix.programId = Keypair.generate().publicKey;
  expectCode(program.validate, "program_mismatch");
  const mode = fixture(); mode.ix.data[40] = 0;
  expectCode(mode.validate, "not_base_input");
  const min = fixture(); min.shape.swap.minOutputAmount = "0";
  expectCode(min.validate, "min_output_invalid");
});
it("maps each reject path to its own code, and still accepts a valid swap", () => {
  expect(() => fixture().validate()).not.toThrow();
  const seen = new Set<CompoundSwapGuardCode>();
  const record = (run: () => void, code: CompoundSwapGuardCode) => {
    expectCode(run, code);
    seen.add(code);
  };
  const pool = fixture(); pool.shape.swap.poolId = key();
  record(pool.validate, "pool_mismatch");
  const inputMint = fixture(); inputMint.shape.swap.inputMint = key();
  record(inputMint.validate, "input_mint_mismatch");
  const outputMint = fixture(); outputMint.shape.swap.outputMint = key();
  record(outputMint.validate, "output_mint_mismatch");
  const zeroIn = fixture(); zeroIn.shape.swap.inputAmount = "0";
  record(zeroIn.validate, "input_amount_invalid");
  const hugeIn = fixture(); hugeIn.shape.swap.inputAmount = (MAX_U64 + 1n).toString();
  record(hugeIn.validate, "input_amount_invalid");
  const zeroMin = fixture(); zeroMin.shape.swap.minOutputAmount = "0";
  record(zeroMin.validate, "min_output_invalid");
  const minAboveQuote = fixture(); minAboveQuote.shape.swap.minOutputAmount = "91";
  record(minAboveQuote.validate, "min_output_invalid");
  const hugeQuote = fixture(); hugeQuote.shape.swap.quotedOutputAmount = (MAX_U64 + 1n).toString();
  record(hugeQuote.validate, "quoted_output_invalid");
  const accountMint = fixture(); accountMint.shape.accounts[0].mint = key();
  record(accountMint.validate, "account_mint_mismatch");
  const ata = fixture(); ata.shape.accounts[0].address = ata.shape.state.ataA;
  record(ata.validate, "isolated_account_is_ata");
  const same = fixture(); same.shape.accounts[1].address = same.shape.accounts[0].address;
  record(same.validate, "isolated_accounts_equal");
  const emptyTicks = fixture(); emptyTicks.shape.tickArrays = [];
  record(emptyTicks.validate, "tick_arrays_empty");
  const dupTicks = fixture(); dupTicks.shape.tickArrays = [dupTicks.shape.tickArrays[0]!, dupTicks.shape.tickArrays[0]!];
  record(dupTicks.validate, "tick_arrays_duplicate");
  const observation = fixture(); observation.shape.observation = key();
  record(observation.validate, "observation_mismatch");
  const program = fixture(); program.ix.programId = Keypair.generate().publicKey;
  record(program.validate, "program_mismatch");
  const shortData = fixture(); shortData.ix.data = Buffer.from(shortData.ix.data.subarray(0, 40));
  record(shortData.validate, "data_length_mismatch");
  const disc = fixture(); disc.ix.data[0] = disc.ix.data[0]! ^ 1;
  record(disc.validate, "discriminator_mismatch");
  const inputData = fixture(); inputData.ix.data.writeBigUInt64LE(101n, 8);
  record(inputData.validate, "input_amount_data_mismatch");
  const minData = fixture(); minData.ix.data.writeBigUInt64LE(0n, 16);
  record(minData.validate, "min_output_data_mismatch");
  const limit = fixture(); limit.ix.data.writeBigUInt64LE(1n, 24);
  record(limit.validate, "price_limit_nonzero");
  const mode = fixture(); mode.ix.data[40] = 0;
  record(mode.validate, "not_base_input");
  const keys = fixture(); keys.ix.keys.pop();
  record(keys.validate, "key_count_mismatch");
  const pubkey = fixture(); pubkey.ix.keys[5]!.pubkey = Keypair.generate().publicKey;
  record(pubkey.validate, "account_pubkey_mismatch");
  const signer = fixture(); signer.ix.keys[4]!.isSigner = true;
  record(signer.validate, "account_signer_mismatch");
  const writable = fixture(); writable.ix.keys[11]!.isWritable = true;
  record(writable.validate, "account_writable_mismatch");
  expect([...seen].sort()).toEqual([...COMPOUND_SWAP_GUARD_CODES].sort());
});
it("rejects a 10-byte swap_v2 as data_length_mismatch without reading past the buffer", () => {
  const short = fixture();
  short.ix.data = Buffer.from(short.ix.data.subarray(0, 10));
  expect(short.ix.data.length).toBe(10);
  expect(() => short.ix.data.readBigUInt64LE(8)).toThrow(RangeError);
  expect(() => short.ix.data.readBigUInt64LE(16)).toThrow(RangeError);
  expectCode(short.validate, "data_length_mismatch");
});
it("rejects the USDC/USDT pool's live observation with observation_mismatch", () => {
  const programId = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
  const poolId = "BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU";
  const liveObservation = "3YZE41e4GKm9Uqvx6H4QA1FdyxT15nEjUP8LbvdiDF2t";
  const pda = getPdaObservationAccount(new PublicKey(programId), new PublicKey(poolId)).publicKey.toBase58();
  expect(pda).toBe("52iUtYQNHvBL9goPUF3FjuFUbvxpAT85CqgBNs5zvZP8");
  expect(liveObservation).not.toBe(pda);
  const { shape } = fixture();
  shape.state.programId = programId;
  shape.state.poolId = poolId;
  shape.swap.poolId = poolId;
  shape.observation = liveObservation;
  const program = new PublicKey(programId), pool = new PublicKey(poolId);
  const rebuilt = ClmmInstrument.swapV2Instruction(program, new PublicKey(shape.state.wallet), pool, new PublicKey(shape.config),
    new PublicKey(shape.accounts[1].address), new PublicKey(shape.accounts[0].address),
    new PublicKey(shape.state.vaultB), new PublicKey(shape.state.vaultA), new PublicKey(shape.swap.inputMint),
    new PublicKey(shape.swap.outputMint), shape.tickArrays.map((address) => new PublicKey(address)), new PublicKey(liveObservation),
    new BN(100), new BN(89), new BN(0), true, getPdaExBitmapAccount(program, pool).publicKey);
  expectCode(() => validateCompoundSwapInstruction(rebuilt, shape), "observation_mismatch");
  // The same instruction is accepted when the observation is the current PDA — the pool itself is not banned.
  const accepted = fixture();
  accepted.shape.state.programId = programId;
  accepted.shape.state.poolId = poolId;
  accepted.shape.swap.poolId = poolId;
  accepted.shape.observation = pda;
  accepted.shape.tickArrays = [getPdaTickArrayAddress(program, pool, 0).publicKey.toBase58()];
  const ok = ClmmInstrument.swapV2Instruction(program, new PublicKey(accepted.shape.state.wallet), pool, new PublicKey(accepted.shape.config),
    new PublicKey(accepted.shape.accounts[1].address), new PublicKey(accepted.shape.accounts[0].address),
    new PublicKey(accepted.shape.state.vaultB), new PublicKey(accepted.shape.state.vaultA), new PublicKey(accepted.shape.swap.inputMint),
    new PublicKey(accepted.shape.swap.outputMint), accepted.shape.tickArrays.map((address) => new PublicKey(address)), new PublicKey(pda),
    new BN(100), new BN(89), new BN(0), true, getPdaExBitmapAccount(program, pool).publicKey);
  expect(() => validateCompoundSwapInstruction(ok, accepted.shape)).not.toThrow();
});
