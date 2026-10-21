import BN from "bn.js";
import Decimal from "decimal.js";
import { AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TickUtil, SqrtPriceMath, LiquidityMathUtil } from "@raydium-io/raydium-sdk-v2";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("@sofinance/engine/swap/jupiter", async (importOriginal) => ({
  ...await importOriginal<typeof import("@sofinance/engine/swap/jupiter")>(),
  buildRoute: vi.fn(), quoteRoute: vi.fn(),
}));

import { readSelectedPositionState, type SelectedPositionState } from "@sofinance/engine/selected-state";
import { buildRoute, quoteRoute } from "@sofinance/engine/swap/jupiter";
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { getSelectedQuoteBundle, searchSelectedQuoteBundle } from "./selected-quote";
import { JUPITER_NO_ROUTE_CODE } from "./selected-no-route";
import { AMOUNT_TOO_SMALL_CODE, AMOUNT_TOO_SMALL_MESSAGE } from "./selected-amount-error";

const wallet = "FakeWa11etAddressForTestingPurposes1111111111";
const mintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mintB = "So11111111111111111111111111111111111111112";
const positionMint = "FakePositionMintForTestsOnly111111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SOFINANCE_FEE_WALLET", undefined);
  vi.mocked(readSelectedPositionState).mockResolvedValue({
    wallet, positionMint, positionAccount: "position", poolId: "pool", inputMint: mintA,
    inputKind: "token", inputDecimals: 6, inputBalance: "1000000000",
    mintA, mintB, decimalsA: 6, decimalsB: 9,
    rangeSide: "below", sqrtPriceX64: TickUtil.getSqrtPriceAtTick(-200).toString(),
    lowerSqrtX64: TickUtil.getSqrtPriceAtTick(-100).toString(),
    upperSqrtX64: TickUtil.getSqrtPriceAtTick(100).toString(),
    tickCurrent: -200, tickSpacing: 1, poolLiquidity: "100000000000000000000", slot: 1,
    ownsNft: true, paused: false, frozen: false, transferFee: false,
    unsupportedExtensions: [], sufficientSol: true,
  } as unknown as SelectedPositionState);
});

afterEach(() => vi.unstubAllEnvs());

describe("selected quote", () => {
  it("keeps a same-pool input on the compact budget without Jupiter quotes", async () => {
    const selection = { positionMint, inputMint: mintA, inputKind: "token" as const };
    const { quote, legs } = await searchSelectedQuoteBundle(wallet, selection, "100", 9_900, 100,
      { buildTransactions: false, includeResale: false });
    expect(quote.minOutA).toBe("100000000");
    expect(legs[0]?.route).toBeNull();
    expect(quoteRoute).not.toHaveBeenCalled();
    expect(buildRoute).not.toHaveBeenCalled();
  });
  it("uses a pool asset directly and values it back in the same asset", async () => {
    const selection = { positionMint, inputMint: mintA, inputKind: "token" as const };
    const { quote, legs } = await getSelectedQuoteBundle(wallet, selection, "100", 9_900);
    expect(quote.requested).toBe("100000000");
    expect(quote.minOutA).toBe("100000000");
    expect(quote.spendB).toBe("0");
    expect(quote.resaleInput).not.toBe("0");
    expect(quote.inputMint).toBe(mintA);
    expect(legs[0]?.route).toBeNull();
    expect(buildRoute).not.toHaveBeenCalled();
  });

  it("rejects an amount larger than the selected asset balance", async () => {
    const selection = { positionMint, inputMint: mintA, inputKind: "token" as const };
    await expect(getSelectedQuoteBundle(wallet, selection, "1001", 9_900)).rejects.toThrow(/balance.*insufficient|insufficient.*balance/i);
  });

  it("sizes liquidity below the swap output and pads amountMax by the tolerance", async () => {
    const selection = { positionMint, inputMint: mintA, inputKind: "token" as const };
    const strict = (await getSelectedQuoteBundle(wallet, selection, "100", 9_900, 0)).quote;
    const tolerant = (await getSelectedQuoteBundle(wallet, selection, "100", 9_900, 100)).quote;
    expect(strict.toleranceBps).toBe(0);
    expect(tolerant.toleranceBps).toBe(100);
    expect(BigInt(tolerant.liquidity)).toBeLessThan(BigInt(strict.liquidity));
    expect(BigInt(strict.amountMaxA)).toBe(BigInt(strict.requiredA));
    expect(BigInt(tolerant.amountMaxA)).toBeLessThanOrEqual(BigInt(tolerant.minOutA));
    // Padded by 1% (rounded up) unless that would exceed the guaranteed swap output.
    const padded = (BigInt(tolerant.requiredA) * 10_100n + 9_999n) / 10_000n;
    const out = BigInt(tolerant.minOutA);
    expect(BigInt(tolerant.amountMaxA)).toBe(padded < out ? padded : out);
    expect(BigInt(tolerant.amountMaxA) * 10_000n).toBeGreaterThanOrEqual(BigInt(tolerant.requiredA) * 10_099n);
    // The tolerance reserve stays in the wallet and still counts toward resale value.
    expect(tolerant.resaleInput).toBe(strict.resaleInput);
    expect(tolerant.passesFloor).toBe(true);
  });

  it("rejects a tolerance above 5%", async () => {
    const selection = { positionMint, inputMint: mintA, inputKind: "token" as const };
    await expect(getSelectedQuoteBundle(wallet, selection, "100", 9_900, 600)).rejects.toThrow(/tolerance/i);
  });
});


describe("bounded selected allocation", () => {
  const source = "InputMintForTwoSwapTest";
  const route = (inputMint: string, outputMint: string, amount: bigint) => ({ inputMint, outputMint,
    inAmount: amount.toString(), outAmount: amount.toString(), otherAmountThreshold: amount.toString(),
    swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0", routePlan: [{ percent: 100, bps: 10000,
      swapInfo: { ammKey: "other-pool", inputMint, outputMint, inAmount: amount.toString(), outAmount: amount.toString() } }],
  });
  function insideState() {
    vi.mocked(readSelectedPositionState).mockResolvedValue({
      wallet, positionMint, positionAccount: "position", poolId: "pool", inputMint: source,
      inputKind: "token", inputDecimals: 6, inputBalance: "1000000000", mintA, mintB,
      decimalsA: 6, decimalsB: 6, rangeSide: "inside", sqrtPriceX64: TickUtil.getSqrtPriceAtTick(0).toString(),
      lowerSqrtX64: TickUtil.getSqrtPriceAtTick(-100).toString(), upperSqrtX64: TickUtil.getSqrtPriceAtTick(100).toString(),
      tickCurrent: 0, tickSpacing: 1, poolLiquidity: "100000000000000000000", slot: 1,
      ownsNft: true, paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
    } as unknown as SelectedPositionState);
    vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => route(input, output, amount));
    vi.mocked(buildRoute).mockImplementation(async (_wallet, input, output, amount) => route(input, output, amount) as never);
  }
  it("sizes pool-token deposits at the own-pool post-swap price", async () => {
    insideState();
    const snapshot = await readSelectedPositionState(wallet, { positionMint, inputMint: mintB, inputKind: "token" });
    snapshot.inputMint = mintB;
    snapshot.sqrtPriceX64 = TickUtil.getSqrtPriceAtTick(10).toString();
    snapshot.tickCurrent = 10;
    snapshot.poolLiquidity = "1000000000000";
    vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => ({ ...route(input, output, amount),
      routePlan: [{ percent: 100, bps: 10000, swapInfo: { ammKey: "pool", inputMint: input,
        outputMint: output, inAmount: amount.toString(), outAmount: amount.toString() } }] }));
    const { quote, legs } = await getSelectedQuoteBundle(wallet,
      { positionMint, inputMint: mintB, inputKind: "token" }, "100", 9900, 100, { maxAccounts: 48 },
      { state: snapshot, buildTransactions: false, includeResale: false });
    const swap = legs.find(leg => leg.route)!;
    const sqrt = SqrtPriceMath.getNextSqrtPriceFromInput(new BN(snapshot.sqrtPriceX64),
      new BN(snapshot.poolLiquidity), new BN(swap.route!.inAmount), false);
    expect(quote.routeTouchesTargetPool).toBe(true);
    expect(quote.projectedPrice).toBe(TickUtil.sqrtPriceX64ToPrice(sqrt, 6, 6).toString());
    const amounts = LiquidityMathUtil.getAmountsForLiquidity(sqrt, new BN(snapshot.lowerSqrtX64),
      new BN(snapshot.upperSqrtX64), new BN(quote.liquidity), true);
    expect(quote.requiredA).toBe(amounts.amountA.toString());
    expect(quote.requiredB).toBe(amounts.amountB.toString());
    expect(vi.mocked(quoteRoute).mock.calls.every(call => call[3]?.onlyDirectRoutes === true)).toBe(true);
  });
  describe("own-pool projection on a wide tick spacing", () => {
    async function quoteWithLiquidity(poolLiquidity: string) {
      insideState();
      const snapshot = await readSelectedPositionState(wallet, { positionMint, inputMint: mintB, inputKind: "token" });
      Object.assign(snapshot, { inputMint: mintB, tickCurrent: 10, tickSpacing: 60, poolLiquidity,
        sqrtPriceX64: TickUtil.getSqrtPriceAtTick(10).add(TickUtil.getSqrtPriceAtTick(11)).divn(2).toString() });
      vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => ({ ...route(input, output, amount),
        routePlan: [{ percent: 100, bps: 10000, swapInfo: { ammKey: "pool", inputMint: input,
          outputMint: output, inAmount: amount.toString(), outAmount: amount.toString() } }] }));
      return getSelectedQuoteBundle(wallet, { positionMint, inputMint: mintB, inputKind: "token" }, "100", 9900, 100,
        { maxAccounts: 48 }, { state: snapshot, buildTransactions: false, includeResale: false });
    }
    it("accepts a swap that crosses raw ticks but stays inside the tick-spacing band", async () => {
      const { quote } = await quoteWithLiquidity("200000000000");
      const tick = TickUtil.getTickAtSqrtPrice(TickUtil.priceToSqrtPriceX64(new Decimal(quote.projectedPrice), 6, 6));
      expect(tick).toBeGreaterThan(10);
      expect(tick).toBeLessThan(60);
    });
    it("rejects a swap that leaves the tick-spacing band even inside the position range", async () => {
      await expect(quoteWithLiquidity("14000000000")).rejects.toThrow(/tick-spacing boundary/);
    });
  });
  it("preview sizes from the pool price: one quote per leg, no probes, builds or reverse resale", async () => {
    insideState();
    const { quote } = await getSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100",
      9900, 100, { maxAccounts: 24 }, { buildTransactions: false, includeResale: false });
    expect(quoteRoute).toHaveBeenCalledTimes(2); expect(buildRoute).not.toHaveBeenCalled();
    expect(quote.resaleInput).toBeNull(); expect(quote.roundtripCostInput).toBeNull();
    expect(BigInt(quote.spendA) + BigInt(quote.spendB)).toBe(100000000n);
    expect(BigInt(quote.requiredA)).toBeLessThanOrEqual(BigInt(quote.amountMaxA));
    expect(BigInt(quote.amountMaxA)).toBeLessThanOrEqual(BigInt(quote.minOutA));
  });
  it("prepare builds each converged leg once from the quote that sized it; preserves floor by default", async () => {
    insideState();
    const result = await getSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100", 9900, 100);
    // Two sizing quotes + two resale quotes; swap-instructions only for the two final legs.
    expect(buildRoute).toHaveBeenCalledTimes(2); expect(quoteRoute).toHaveBeenCalledTimes(4);
    const sizing = await Promise.all(vi.mocked(quoteRoute).mock.results.slice(0, 2).map(result => result.value));
    expect(vi.mocked(buildRoute).mock.calls.map(call => call[11])).toEqual(sizing);
    expect(result.quote.resaleInput).not.toBeNull(); expect(result.quote.passesFloor).toBe(true);
  });
  it("retries compact no-route with a wider account budget for a cross-asset input", async () => {
    insideState();
    vi.mocked(quoteRoute).mockImplementation(async (input, output, amount, constraints) => {
      if ((constraints?.maxAccounts ?? 24) < 32) throw new JupiterNoRouteError();
      return route(input, output, amount);
    });
    const { quote } = await searchSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100",
      9900, 100, { buildTransactions: false, includeResale: false });
    expect(BigInt(quote.spendA) + BigInt(quote.spendB)).toBe(100000000n);
    expect(vi.mocked(quoteRoute).mock.calls.some((call) => call[3]?.maxAccounts === 24)).toBe(true);
    expect(vi.mocked(quoteRoute).mock.calls.some((call) => call[3]?.maxAccounts === 32)).toBe(true);
    expect(vi.mocked(quoteRoute).mock.calls.every((call) => (call[3]?.maxAccounts ?? 0) <= 32)).toBe(true);
  });
  it("maps exhausted cross-asset no-route to a coded user-facing error", async () => {
    insideState();
    vi.mocked(quoteRoute).mockRejectedValue(new JupiterNoRouteError());
    await expect(searchSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100",
      9900, 100, { buildTransactions: false, includeResale: false })).rejects.toMatchObject({
      name: "SelectedNoRouteError", code: JUPITER_NO_ROUTE_CODE,
    });
  });
  it("skips unquoteable Jupiter probes for a tiny balanced input and never sends dust sizes", async () => {
    insideState();
    vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => {
      if (amount < 200n) {
        throw new JupiterHttpError(400, "/swap/v1/quote", null,
          "Cannot compute other amount threshold, with amount 1 and slippageBps 50");
      }
      return route(input, output, amount);
    });
    const { quote } = await getSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" },
      "0.0011", 9900, 100, { maxAccounts: 24 }, { buildTransactions: false, includeResale: false });
    expect(quote.requested).toBe("1100");
    expect(BigInt(quote.spendA) + BigInt(quote.spendB)).toBe(1100n);
    expect(vi.mocked(quoteRoute).mock.calls.every((call) => call[2] >= 200n)).toBe(true);
  });
  it("maps a dust Jupiter 400 to a coded amount-too-small error", async () => {
    insideState();
    vi.mocked(quoteRoute).mockRejectedValue(new JupiterHttpError(400, "/swap/v1/quote", null,
      "Cannot compute other amount threshold, with amount 1 and slippageBps 50"));
    await expect(searchSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100",
      9900, 100, { buildTransactions: false, includeResale: false })).rejects.toMatchObject({
      name: "AmountTooSmallError", code: AMOUNT_TOO_SMALL_CODE, message: AMOUNT_TOO_SMALL_MESSAGE,
    });
  });
  it("rejects a one-raw-unit swap without calling Jupiter", async () => {
    insideState();
    await expect(getSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" },
      "0.000001", 9900, 100, { maxAccounts: 24 }, { buildTransactions: false, includeResale: false }))
      .rejects.toMatchObject({ name: "AmountTooSmallError", code: AMOUNT_TOO_SMALL_CODE });
    expect(quoteRoute).not.toHaveBeenCalled();
  });
});

it.each(["native", "token"] as const)("selected add charges the configured fee on %s swaps", async kind => {
  const feeWallet = Keypair.generate().publicKey;
  vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  const original = await readSelectedPositionState(wallet, { positionMint, inputMint: mintB, inputKind: kind });
  const state = { ...original, inputMint: mintB, inputKind: kind, inputDecimals: 6,
    programA: TOKEN_PROGRAM_ID.toBase58(), inputTokenProgram: TOKEN_PROGRAM_ID.toBase58(), wsolBalance: "0" };
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: new PublicKey(mintB), owner: feeWallet, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  const connection = { getAccountInfo: vi.fn(async () => ({ data, owner: TOKEN_PROGRAM_ID })) } as never;
  const route = (inputMint: string, outputMint: string, amount: bigint) => ({ inputMint, outputMint,
    inAmount: amount.toString(), outAmount: amount.toString(), otherAmountThreshold: amount.toString(),
    routePlan: [], priceImpactPct: "0" });
  vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => route(input, output, amount) as never);
  vi.mocked(buildRoute).mockImplementation(async (_wallet, input, output, amount) => route(input, output, amount) as never);
  const result = await getSelectedQuoteBundle(wallet, { positionMint, inputMint: mintB, inputKind: kind }, "100", 9900, 100,
    undefined, { state, connection, includeResale: false });
  expect(result.quote.feeAmount).toBe("0");
  expect(result.legs[0]!.route!.inAmount).toBe("100000000");
});
