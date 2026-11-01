import BN from "bn.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiquidityMathUtil } from "@raydium-io/raydium-sdk-v2";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("@sofinance/engine/swap/jupiter", async (importOriginal) => ({
  ...await importOriginal<typeof import("@sofinance/engine/swap/jupiter")>(),
  buildRoute: vi.fn(), quoteRoute: vi.fn(),
}));

import { readSelectedPositionState, type SelectedPositionState } from "@sofinance/engine/selected-state";
import { buildRoute, quoteRoute } from "@sofinance/engine/swap/jupiter";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { allocateSpend } from "@sofinance/engine/quote-math";
import { clampInsideSpend, getSelectedQuoteBundle, minorityLegFloor } from "./selected-quote";
import { AMOUNT_TOO_SMALL_CODE, AmountTooSmallError, formatAmountTooSmallMessage } from "./selected-amount-error";

// Mainnet snapshot (read-only, public RPC) of LJ's INTCx/INTCy position: a 1-tick range with the
// pool price sitting at its lower edge, so the position needs ~99.99% INTCx and ~0.01% INTCy.
const wallet = "FakeWa11etAddressForTestingPurposes1111111111";
const positionMint = "FakePositionMintForTestsOnly111111111111111";
const INTCX = "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM"; // mintA, 8 decimals
const INTCY = "iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF"; // mintB, 6 decimals
const POOL = "9Ur3oKPMp4thfE5DFL8vVVe3k3d4RSjHEtS9zvBDC41K";
const SQRT = "1844582588123586646";
const LOWER = "1844582586965359236";
const UPPER = "1844674813789094274";
const POOL_LIQUIDITY = "5189129581607";
const Q128 = 1n << 128n;

function edgeState(inputMint = INTCX): SelectedPositionState {
  return {
    wallet, positionMint, positionAccount: "position", poolId: POOL, inputMint, inputKind: "token",
    inputDecimals: inputMint === INTCX ? 8 : 6, inputBalance: "100000000000", mintA: INTCX, mintB: INTCY,
    decimalsA: 8, decimalsB: 6, rangeSide: "inside", sqrtPriceX64: SQRT, lowerSqrtX64: LOWER, upperSqrtX64: UPPER,
    tickCurrent: -46055, tickSpacing: 1, poolLiquidity: POOL_LIQUIDITY, slot: 1,
    ownsNft: true, paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
  } as unknown as SelectedPositionState;
}

// Jupiter output at the pool price (raw B per raw A = sqrt^2 / 2^128), rejecting dust exactly like Jupiter's 400.
function priced(inputMint: string, outputMint: string, amount: bigint, ammKey = "other-pool") {
  if (amount < 200n) {
    throw new JupiterHttpError(400, "/swap/v1/quote", null, `Cannot compute other amount threshold, with amount ${amount} and slippageBps 50`);
  }
  const sqrt = BigInt(SQRT);
  const out = inputMint === INTCX ? amount * sqrt * sqrt / Q128 : amount * Q128 / (sqrt * sqrt);
  const outAmount = out.toString(), threshold = (out * 9950n / 10000n).toString();
  return { inputMint, outputMint, inAmount: amount.toString(), outAmount, otherAmountThreshold: threshold,
    swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0", routePlan: [{ percent: 100, bps: 10000,
      swapInfo: { ammKey, inputMint, outputMint, inAmount: amount.toString(), outAmount } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SOFINANCE_FEE_WALLET", undefined);
  vi.mocked(readSelectedPositionState).mockResolvedValue(edgeState());
  vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => priced(input, output, amount) as never);
  vi.mocked(buildRoute).mockImplementation(async (_w, input, output, amount) => priced(input, output, amount) as never);
});
afterEach(() => vi.unstubAllEnvs());

const quoteIntcx = (amount: string) => getSelectedQuoteBundle(wallet, { positionMint, inputMint: INTCX, inputKind: "token" },
  amount, 9900, 100, { maxAccounts: 24 }, { buildTransactions: false, includeResale: false });

describe("dust minority leg on a 1-tick range at its edge", () => {
  it("reproduces the bug: the pool-price split leaves an unquoteable 189-unit INTCy leg for 0.15020418 INTCx", () => {
    const sqrt = new BN(SQRT), lower = new BN(LOWER), upper = new BN(UPPER);
    const base = LiquidityMathUtil.getAmountsForLiquidity(sqrt, lower, upper, new BN("1000000000000000000"), true);
    const rateB = { spend: Q128, out: BigInt(SQRT) ** 2n };
    const spendA = allocateSpend(15_020_418n, BigInt(base.amountA.toString()), BigInt(base.amountB.toString()),
      { spend: 1n, out: 1n }, rateB, 0n);
    expect(15_020_418n - spendA).toBe(189n);
    expect(15_020_418n - spendA).toBeLessThan(200n);
  });

  it("bumps the INTCy leg to a quotable size and adds liquidity for 0.15020418 INTCx", async () => {
    const { quote } = await quoteIntcx("0.15020418");
    expect(quote.requested).toBe("15020418");
    expect(BigInt(quote.spendA) + BigInt(quote.spendB)).toBe(15_020_418n);
    // Raised from 189 to the 1 bps floor (1502 units), i.e. <= 0.01% of the deposit.
    expect(quote.spendB).toBe("1502");
    expect(BigInt(quote.liquidity)).toBeGreaterThan(0n);
    expect(BigInt(quote.requiredB)).toBeLessThanOrEqual(BigInt(quote.minOutB));
    expect(vi.mocked(quoteRoute).mock.calls.every((call) => call[2] >= 200n)).toBe(true);
  });

  it("also works when Jupiter routes the bumped leg through the target pool itself", async () => {
    vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => priced(input, output, amount, POOL) as never);
    const { quote } = await quoteIntcx("0.15020418");
    expect(quote.routeTouchesTargetPool).toBe(true);
    expect(BigInt(quote.liquidity)).toBeGreaterThan(0n);
  });

  it("keeps an INTCy deposit working: almost all is swapped to INTCx, a few INTCy units stay unswapped", async () => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(edgeState(INTCY));
    const { quote } = await getSelectedQuoteBundle(wallet, { positionMint, inputMint: INTCY, inputKind: "token" },
      "0.2", 9900, 100, { maxAccounts: 24 }, { buildTransactions: false, includeResale: false });
    expect(BigInt(quote.spendA)).toBeGreaterThanOrEqual(200n);
    expect(BigInt(quote.spendB)).toBeGreaterThanOrEqual(1n);
    expect(BigInt(quote.liquidity)).toBeGreaterThan(0n);
  });

  it("explains a genuine too-small amount with its real cause and the computed minimum", async () => {
    const failure = await quoteIntcx("0.0000015").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AmountTooSmallError);
    expect(failure).toMatchObject({ code: AMOUNT_TOO_SMALL_CODE,
      detail: { minimumInput: "201", inputDecimals: 8, minorityMint: INTCY, majorityMint: INTCX } });
    expect((failure as Error).message).toMatch(/price range is narrow and the pool price sits at its edge/);
    expect((failure as Error).message).toMatch(/Enter at least 0\.00000201 /);
    expect(quoteRoute).not.toHaveBeenCalled();
  });
});

describe("minority leg floor", () => {
  it("is 1 bps of the deposit, at least Jupiter's 200-unit minimum and at most 100x it", () => {
    expect(minorityLegFloor(1_000n)).toBe(200n);
    expect(minorityLegFloor(15_020_418n)).toBe(1_502n);
    expect(minorityLegFloor(10n ** 12n)).toBe(20_000n);
  });
  it("clamps either side and leaves balanced allocations alone", () => {
    const floors = { a: 1n, b: 1_502n };
    expect(clampInsideSpend(15_020_418n, 15_020_229n, floors)).toBe(15_018_916n);
    expect(clampInsideSpend(15_020_418n, 0n, { a: 200n, b: 200n })).toBe(200n);
    expect(clampInsideSpend(15_020_418n, 7_000_000n, floors)).toBe(7_000_000n);
  });
  it("formats both wordings", () => {
    expect(formatAmountTooSmallMessage({ input: "INTCx", minority: "INTCy", majority: "INTCx", minimum: "0.00000201" }))
      .toBe("This position's price range is narrow and the pool price sits at its edge, so it needs almost only INTCx. " +
        "The INTCy part of this amount is below the smallest swap Jupiter can quote. Enter at least 0.00000201 INTCx.");
    expect(formatAmountTooSmallMessage({ input: "USDC", minority: "SOL", minimum: "0.0002" }))
      .toBe("This amount is below the smallest swap Jupiter can quote for the SOL part. Enter at least 0.0002 USDC.");
  });
});
