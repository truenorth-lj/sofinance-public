import { beforeEach, describe, expect, it, vi } from "vitest";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";

vi.mock("server-only", () => ({}));
vi.mock("./selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("./jupiter-route", () => ({ buildRoute: vi.fn(), quoteRoute: vi.fn() }));

import { readSelectedPositionState, type SelectedPositionState } from "./selected-state";
import { buildRoute, quoteRoute } from "./jupiter-route";
import { getSelectedQuoteBundle } from "./selected-quote";

const wallet = "FakeWa11etAddressForTestingPurposes1111111111";
const mintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mintB = "So11111111111111111111111111111111111111112";
const positionMint = "FakePositionMintForTestsOnly111111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSelectedPositionState).mockResolvedValue({
    wallet, positionMint, positionAccount: "position", poolId: "pool", inputMint: mintA,
    inputKind: "token", inputDecimals: 6, inputBalance: "1000000000",
    mintA, mintB, decimalsA: 6, decimalsB: 9,
    rangeSide: "below", sqrtPriceX64: TickUtil.getSqrtPriceAtTick(-200).toString(),
    lowerSqrtX64: TickUtil.getSqrtPriceAtTick(-100).toString(),
    upperSqrtX64: TickUtil.getSqrtPriceAtTick(100).toString(),
    tickCurrent: -200, poolLiquidity: "100000000000000000000", slot: 1,
    ownsNft: true, paused: false, frozen: false, transferFee: false,
    unsupportedExtensions: [], sufficientSol: true,
  } as unknown as SelectedPositionState);
});

describe("selected quote", () => {
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
      tickCurrent: 0, poolLiquidity: "100000000000000000000", slot: 1,
      ownsNft: true, paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
    } as unknown as SelectedPositionState);
    vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => route(input, output, amount));
    vi.mocked(buildRoute).mockImplementation(async (_wallet, input, output, amount) => route(input, output, amount) as never);
  }
  it("preview uses exactly four lightweight quotes, no transaction builds or reverse resale", async () => {
    insideState();
    const { quote } = await getSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100",
      9900, 100, { maxAccounts: 24 }, { buildTransactions: false, includeResale: false });
    expect(quoteRoute).toHaveBeenCalledTimes(4); expect(buildRoute).not.toHaveBeenCalled();
    expect(quote.resaleInput).toBeNull(); expect(quote.roundtripCostInput).toBeNull();
    expect(BigInt(quote.spendA) + BigInt(quote.spendB)).toBe(100000000n);
    expect(BigInt(quote.requiredA)).toBeLessThanOrEqual(BigInt(quote.amountMaxA));
    expect(BigInt(quote.amountMaxA)).toBeLessThanOrEqual(BigInt(quote.minOutA));
  });
  it("prepare uses two probes and exactly two actual builds; preserves floor by default", async () => {
    insideState();
    const result = await getSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100", 9900, 100);
    expect(buildRoute).toHaveBeenCalledTimes(2); expect(quoteRoute).toHaveBeenCalledTimes(4);
    expect(result.quote.resaleInput).not.toBeNull(); expect(result.quote.passesFloor).toBe(true);
  });
  it("still rejects degradation relative to the small probe", async () => {
    insideState();
    vi.mocked(buildRoute).mockImplementation(async (_wallet, input, output, amount) => ({
      ...route(input, output, amount), otherAmountThreshold: (amount / 2n).toString(),
    }) as never);
    await expect(getSelectedQuoteBundle(wallet, { positionMint, inputMint: source, inputKind: "token" }, "100", 9900, 100,
      { maxAccounts: 24 }, { includeResale: false })).rejects.toThrow("Price impact relative to probe route");
  });
});
