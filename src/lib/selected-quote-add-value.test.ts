import { Keypair } from "@solana/web3.js";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("@sofinance/engine/swap/jupiter", async (importOriginal) => ({
  ...await importOriginal<typeof import("@sofinance/engine/swap/jupiter")>(),
  buildRoute: vi.fn(), quoteRoute: vi.fn(),
}));

import type { SelectedPositionState } from "@sofinance/engine/selected-state";
import { buildRoute, quoteRoute } from "@sofinance/engine/swap/jupiter";
import { getSelectedQuoteBundle, isNarrowRange, type UsdPriceReader } from "./selected-quote";
import { ADD_VALUE_TOO_LOW_CODE, ADD_VALUE_UNPRICED_CODE, ADD_VALUE_UNPRICED_MESSAGE, ADD_VALUE_UNPRICED_NARROW_MESSAGE, AddValueBlockedError } from "./dex/add-value-guard";
import { publicErrorCode, sanitizePublicError } from "./public-error";

// LJ's 2026-11-15 12:44 add (Asia/Taipei): 400 USDC into the INTCx/INTC 1 bps pool 9Ur3…C41K, position range
// [-46055, -46054] (one tick on a 1-spacing pool). Public-RPC snapshot: pool tick -46057, below the range, so the add
// is one USDC → INTCx swap. INTCx and INTC both trade near $57.95.
const wallet = "FakeWa11etAddressForTestingPurposes1111111111";
const positionMint = "FakePositionMintForTestsOnly111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INTCX = "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM"; // mintA, 8 decimals
const INTC = "iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF"; // mintB, 6 decimals
const POOL = "9Ur3oKPMp4thfE5DFL8vVVe3k3d4RSjHEtS9zvBDC41K";
const STOCK_USD = 57.95;
const MARKET: Record<string, number> = { [USDC]: 1, [INTCX]: STOCK_USD, [INTC]: STOCK_USD };

function state(overrides: Partial<Record<keyof SelectedPositionState, unknown>> = {}): SelectedPositionState {
  return {
    wallet, positionMint, positionAccount: "position", poolId: POOL, inputMint: USDC, inputKind: "token",
    inputDecimals: 6, inputBalance: "1000000000", mintA: INTCX, mintB: INTC, decimalsA: 8, decimalsB: 6,
    rangeSide: "below", sqrtPriceX64: "1844455108192120930", tickCurrent: -46057, tickSpacing: 1,
    tickLower: -46055, tickUpper: -46054,
    lowerSqrtX64: TickUtil.getSqrtPriceAtTick(-46055).toString(), upperSqrtX64: TickUtil.getSqrtPriceAtTick(-46054).toString(),
    poolLiquidity: "437267695699", slot: 1, ownsNft: true, paused: false, frozen: false, transferFee: false,
    unsupportedExtensions: [], sufficientSol: true, ...overrides,
  } as unknown as SelectedPositionState;
}

/** A Jupiter route that never touches the target pool, at `usdPerToken` per output token, reporting zero impact. */
function route(inputMint: string, outputMint: string, amount: bigint, usdPerToken: number) {
  const decimals = outputMint === INTCX ? 8 : 6;
  const out = BigInt(Math.floor(Number(amount) / 1e6 / usdPerToken * 10 ** decimals));
  return { inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString(),
    otherAmountThreshold: (out * 9950n / 10000n).toString(), swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0",
    routePlan: [{ percent: 100, bps: 10000, swapInfo: { ammKey: "other-pool", inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString() } }] };
}
function routesAt(usdPerToken: number) {
  vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => route(input, output, amount, usdPerToken) as never);
  vi.mocked(buildRoute).mockImplementation(async (_w, input, output, amount) => route(input, output, amount, usdPerToken) as never);
}
const market: UsdPriceReader = async (mints) => new Map(mints.flatMap((mint) => MARKET[mint] ? [[mint, MARKET[mint]!] as const] : []));
const noPrices: UsdPriceReader = async () => new Map();

const add = (snapshot: SelectedPositionState, prices: UsdPriceReader, amount = "400") => getSelectedQuoteBundle(wallet,
  { positionMint, inputMint: USDC, inputKind: "token" }, amount, 9900, 100, { maxAccounts: 24 },
  { state: snapshot, prices, buildTransactions: false, includeResale: false });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SOFINANCE_FEE_WALLET", Keypair.generate().publicKey.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
});
afterEach(() => vi.unstubAllEnvs());

describe("Add value floor (independent USD prices, before anything is built or signed)", () => {
  it("lets the incident's fairly priced 400 USDC add through, keeping the 10 bps swap fee", async () => {
    routesAt(STOCK_USD);
    const { quote, legs } = await add(state(), market);
    expect(quote.feeBps).toBe(10);
    expect(quote.feeAmount).toBe("400000");
    expect(legs[0]?.route?.routePlan.every((hop) => hop.swapInfo.ammKey !== POOL)).toBe(true);
    // About 6.74 INTCx (~$390) into the position, the 1% tolerance reserve stays in the wallet.
    expect(Number(quote.requiredA) / 1e8 * STOCK_USD).toBeGreaterThan(385);
  });

  it("blocks a swap that would hand back far less than the input is worth, even with a 0% reported impact", async () => {
    routesAt(STOCK_USD * 60); // ~$6.6 of INTCx for 400 USDC, the shape the wallet warned about
    const error = await add(state(), market).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AddValueBlockedError);
    const message = sanitizePublicError(error, "Quote failed");
    expect(message).toMatch(/^Only about \$6\.\d\d of your \$400 would go into this position \(plus about \$0\.\d\d left in your wallet\), because the swap price/);
    expect(message).toMatch(/Nothing was sent\. Try a smaller amount\.$/);
    expect(publicErrorCode(error)).toBe(ADD_VALUE_TOO_LOW_CODE);
  });

  it("blocks just below 97% and passes just above it", async () => {
    // 400 USDC, 10 bps fee, 0.5% slippage floor, 1% reserve: a 2% worse route is still above the floor, 3% is not.
    routesAt(STOCK_USD * 1.02);
    await expect(add(state(), market)).resolves.toBeDefined();
    routesAt(STOCK_USD * 1.035);
    await expect(add(state(), market)).rejects.toBeInstanceOf(AddValueBlockedError);
  });

  describe("1-tick range", () => {
    it("is detected from the position's own ticks", () => {
      expect(isNarrowRange(state())).toBe(true);
      expect(isNarrowRange(state({ tickLower: -46060, tickUpper: -46049 }))).toBe(false);
      expect(isNarrowRange(state({ tickSpacing: 60, tickLower: -46080, tickUpper: -46020 }))).toBe(true);
    });

    it("checks value in range with two legs whose routes skip the pool (no pool-price projection runs)", async () => {
      const inside = state({ rangeSide: "inside", tickCurrent: -46055,
        sqrtPriceX64: TickUtil.getSqrtPriceAtTick(-46055).add(TickUtil.getSqrtPriceAtTick(-46054)).divn(2).toString() });
      routesAt(STOCK_USD);
      const { quote } = await add(inside, market);
      expect(quote.routeTouchesTargetPool).toBe(false);
      expect(BigInt(quote.requiredA)).toBeGreaterThan(0n);
      expect(BigInt(quote.requiredB)).toBeGreaterThan(0n);
      // The pool tokens are actually worth much less than the routes assumed: blocked, though no route touches the pool.
      const cheap: UsdPriceReader = async () => new Map([[USDC, 1], [INTCX, STOCK_USD * 0.9], [INTC, STOCK_USD * 0.9]]);
      await expect(add(inside, cheap)).rejects.toBeInstanceOf(AddValueBlockedError);
    });

    it("fails closed when prices are missing on both one-tick and wider ranges", async () => {
      routesAt(STOCK_USD);
      const error = await add(state(), noPrices).catch((caught: unknown) => caught);
      expect(sanitizePublicError(error, "Quote failed")).toBe(ADD_VALUE_UNPRICED_NARROW_MESSAGE);
      // Its own code, so a price feed outage is not reported as a bad swap.
      expect(publicErrorCode(error)).toBe(ADD_VALUE_UNPRICED_CODE);
      expect(ADD_VALUE_UNPRICED_CODE).not.toBe(ADD_VALUE_TOO_LOW_CODE);
      const wide = state({ tickLower: -46056, tickUpper: -46040, lowerSqrtX64: TickUtil.getSqrtPriceAtTick(-46056).toString(),
        upperSqrtX64: TickUtil.getSqrtPriceAtTick(-46040).toString() });
      const wideError = await add(wide, noPrices).catch((caught: unknown) => caught);
      expect(wideError).toBeInstanceOf(AddValueBlockedError);
      expect((wideError as Error).message).toBe(ADD_VALUE_UNPRICED_MESSAGE);
      expect(publicErrorCode(wideError)).toBe(ADD_VALUE_UNPRICED_CODE);
    });
  });
});
