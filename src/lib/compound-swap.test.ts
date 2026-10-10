import BN from "bn.js";
import { ClmmInstrument, getPdaExBitmapAccount, getPdaObservationAccount, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { optimizeCompoundSwap, validateCompoundSwapInstruction, type CompoundSwap, type CompoundSwapShape } from "./compound-swap";
import { sizeCompoundLiquidity } from "./compound-math";
import { computeSwapFee, netSwapInput } from "./swap-fee";
import type { CompoundAccount, CompoundPositionState } from "./compound-types";

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
  const bps = 20;
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
it("rejects ordinary wallet ATA sources, unknown ticks/vaults, and any account privilege changes", () => {
  const source = fixture(); source.ix.keys[3]!.pubkey = new PublicKey(source.shape.state.ataB);
  expect(source.validate).toThrow("account or permission");
  const tick = fixture(); tick.ix.keys[14]!.pubkey = Keypair.generate().publicKey;
  expect(tick.validate).toThrow("account or permission");
  const vault = fixture(); vault.ix.keys[5]!.pubkey = Keypair.generate().publicKey;
  expect(vault.validate).toThrow("account or permission");
  const mint = fixture(); mint.ix.keys[11]!.isWritable = true;
  expect(mint.validate).toThrow("account or permission");
  const signer = fixture(); signer.ix.keys[4]!.isSigner = true;
  expect(signer.validate).toThrow("account or permission");
});
it("rejects input or slippage caps, program, exact-output mode and price-limit tampering", () => {
  for (const [offset, value] of [[8, 101n], [16, 0n], [24, 1n]] as const) {
    const valueCase = fixture(); valueCase.ix.data.writeBigUInt64LE(value, offset);
    expect(valueCase.validate).toThrow(/instruction.*mint.*limit/i);
  }
  const program = fixture(); program.ix.programId = Keypair.generate().publicKey;
  expect(program.validate).toThrow(/instruction.*mint.*limit/i);
  const mode = fixture(); mode.ix.data[40] = 0;
  expect(mode.validate).toThrow(/instruction.*mint.*limit/i);
  const min = fixture(); min.shape.swap.minOutputAmount = "0";
  expect(min.validate).toThrow(/instruction.*mint.*limit/i);
});
