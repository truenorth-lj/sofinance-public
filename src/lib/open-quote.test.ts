import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { uiPriceBPerAFromTick } from "./position-performance-math";

vi.mock("server-only", () => ({}));
vi.mock("./open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("./jupiter-route", () => ({ buildRoute: vi.fn() }));
vi.mock("./open-rent", () => ({
  estimateOpenPositionRent: vi.fn(async () => ({
    refundableLamports: 5_000_000n,
    nonRefundableLamports: 0n,
    positionNftLamports: 2_000_000n,
    nftAtaLamports: 2_000_000n,
    personalPositionLamports: 1_000_000n,
    tickArrayLamports: 0n,
    protocolPositionLamports: 0n,
    tickArrayInitRequired: false,
    protocolPositionInitRequired: false,
    tickArrayAccounts: [],
  })),
}));
vi.mock("./rpc", () => ({ rpcConnection: vi.fn() }));

import { readOpenPoolState, type OpenPoolState } from "./open-state";
import { buildRoute } from "./jupiter-route";
import { estimateOpenPositionRent } from "./open-rent";
import { getOpenPositionQuoteBundle } from "./open-quote";

const wallet = Keypair.generate().publicKey.toBase58();
const mintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mintB = "So11111111111111111111111111111111111111112";
const poolId = Keypair.generate().publicKey.toBase58();

function state(overrides: Partial<OpenPoolState> = {}): OpenPoolState {
  const tickCurrent = 0;
  return {
    wallet, slot: 1, fetchedAt: Date.now(), poolId, programId: "prog",
    inputKind: "token", inputMint: mintA, inputDecimals: 6, inputTokenProgram: "Tokenkeg",
    inputAccount: Keypair.generate().publicKey.toBase58(), inputBalance: "1000000000",
    mintA, mintB, decimalsA: 6, decimalsB: 9, programA: "Tokenkeg", programB: "Tokenkeg",
    ataA: Keypair.generate().publicKey.toBase58(), ataB: Keypair.generate().publicKey.toBase58(),
    vaultA: Keypair.generate().publicKey.toBase58(), vaultB: Keypair.generate().publicKey.toBase58(),
    balances: { a: "0", b: "0", input: "1000000000" },
    sqrtPriceX64: TickUtil.getSqrtPriceAtTick(tickCurrent).toString(),
    tickCurrent, tickSpacing: 1, poolLiquidity: "100000000000000000000",
    price: TickUtil.sqrtPriceX64ToPrice(TickUtil.getSqrtPriceAtTick(tickCurrent), 6, 9).toString(),
    paused: false, transferFee: false, frozen: false, freezeRiskA: false, freezeRiskB: false,
    freezeRisk: false, token2022A: false, token2022B: false, unsupportedExtensions: [],
    solLamports: 50_000_000, sufficientSol: true,
    symbolA: "USDC", symbolB: "SOL", feeTierBps: 4, ...overrides,
  } as OpenPoolState;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readOpenPoolState).mockResolvedValue(state());
});

describe("open-position quote validation", () => {
  it("rejects an amount larger than the selected asset balance", async () => {
    await expect(getOpenPositionQuoteBundle(
      wallet,
      { poolId, inputMint: mintA, inputKind: "token" },
      "1001",
      { preset: "standard" },
    )).rejects.toThrow(/balance/i);
  });

  it("rejects currently charged transfer fees", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ transferFee: true }));
    await expect(getOpenPositionQuoteBundle(
      wallet,
      { poolId, inputMint: mintA, inputKind: "token" },
      "1",
      { preset: "standard" },
    )).rejects.toThrow(/transfer fee/i);
  });

  it("rejects frozen or paused pool assets", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ frozen: true }));
    await expect(getOpenPositionQuoteBundle(
      wallet,
      { poolId, inputMint: mintA, inputKind: "token" },
      "1",
      { preset: "standard" },
    )).rejects.toThrow(/frozen|paused/i);
  });

  it("quotes a pool token below the selected range without a Jupiter hop", async () => {
    const { quote, legs } = await getOpenPositionQuoteBundle(
      wallet,
      { poolId, inputMint: mintA, inputKind: "token" },
      "100",
      { preset: "custom", minPrice: "1", maxPrice: "2" },
    );
    expect(quote.requested).toBe("100000000");
    expect(quote.poolId).toBe(poolId);
    expect(quote.rangeSide).toBe("below");
    expect(quote.tickLower).toBeLessThan(quote.tickUpper);
    expect(quote.passesFloor).toBe(true);
    expect(quote.symbolA).toBe("USDC");
    expect(quote.symbolB).toBe("SOL");
    expect(quote.feeTierBps).toBe(4);
    expect(quote.sufficientSol).toBe(true);
    expect(quote.feeBps).toBe(0);
    expect(quote.feeAmount).toBe("0");
    expect(quote.feeWallet).toBeNull();
    expect(legs[0]?.route).toBeNull();
    expect(uiPriceBPerAFromTick(quote.tickLower, 6, 9)).toBeGreaterThan(Number(quote.currentPrice));
  });

  it("rejects insufficient SOL before sizing liquidity", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ solLamports: 1_000_000, sufficientSol: false }));
    await expect(getOpenPositionQuoteBundle(
      wallet,
      { poolId, inputMint: mintA, inputKind: "token" },
      "1",
      { preset: "standard" },
    )).rejects.toThrow(/0\.01 SOL/);
  });

  it("fails clearly when tick-array init rent exceeds remaining SOL", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ solLamports: 20_000_000, sufficientSol: true }));
    vi.mocked(estimateOpenPositionRent).mockResolvedValue({
      refundableLamports: 5_000_000n,
      nonRefundableLamports: 20_000_000n,
      positionNftLamports: 2_000_000n,
      nftAtaLamports: 2_000_000n,
      personalPositionLamports: 1_000_000n,
      tickArrayLamports: 20_000_000n,
      protocolPositionLamports: 0n,
      tickArrayInitRequired: true,
      protocolPositionInitRequired: false,
      tickArrayAccounts: [Keypair.generate().publicKey.toBase58()],
    });
    await expect(getOpenPositionQuoteBundle(
      wallet,
      { poolId, inputMint: mintA, inputKind: "token" },
      "100",
      { preset: "custom", minPrice: "1", maxPrice: "2" },
    )).rejects.toThrow(/tick array/i);
  });

  it("rejects probe-relative price impact above 5%", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ inputMint: mintB, inputDecimals: 9, inputKind: "token" }));
    vi.mocked(buildRoute).mockImplementation(async (_wallet, _in, _out, spend) => {
      const inAmount = spend.toString();
      const outAmount = spend === 10_000_000n ? "9000000" : "1000";
      return {
        inputMint: mintB, outputMint: mintA, inAmount, outAmount,
        otherAmountThreshold: outAmount, swapMode: "ExactIn", slippageBps: 50,
        priceImpactPct: "0", routePlan: [],
        setupInstructions: [], swapInstruction: {}, cleanupInstruction: null, otherInstructions: [],
        addressesByLookupTableAddress: {},
      } as never;
    });
    await expect(getOpenPositionQuoteBundle(
      wallet,
      { poolId, inputMint: mintB, inputKind: "token" },
      "0.1",
      { preset: "custom", minPrice: "1", maxPrice: "2" },
    )).rejects.toThrow(/Price impact/);
  });

  it("quotes reverse resale so the floor fields stay populated without blocking the quote", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ inputMint: mintB, inputDecimals: 9, inputKind: "token" }));
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => {
      const out = inputMint === mintB && outputMint === mintA ? spend / 1000n : spend;
      return {
        inputMint, outputMint, inAmount: spend.toString(), outAmount: out.toString(),
        otherAmountThreshold: out.toString(), swapMode: "ExactIn", slippageBps: 50,
        priceImpactPct: "0", routePlan: [], setupInstructions: [], swapInstruction: {},
        cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
      } as never;
    });
    const { quote } = await getOpenPositionQuoteBundle(wallet,
      { poolId, inputMint: mintB, inputKind: "token" }, "0.1",
      { preset: "custom", minPrice: "1", maxPrice: "2" });
    expect(quote.minOutA).toBe("100000");
    expect(quote.maxImpactBps).toBe(500);
    expect(quote.floorBps).toBe(9900);
    expect(quote.passesFloor).toBe(false);
    expect(quote.achievedResaleBps).toBe(10);
    expect(buildRoute).toHaveBeenCalledTimes(3);
  });
  it("sizes sequential LP from conservative primary output and applies the same account budget to both probes and swaps", async () => {
    const firstMint = Keypair.generate().publicKey.toBase58(), secondMint = Keypair.generate().publicKey.toBase58();
    const snapshot = state({ mintA: firstMint, mintB: secondMint, decimalsA: 6, decimalsB: 6,
      inputMint: mintA, inputDecimals: 6, fetchedAt: Date.now(), price: "1" });
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
      inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString(),
      otherAmountThreshold: (spend * 99n / 100n).toString(), swapMode: "ExactIn", slippageBps: 50,
      priceImpactPct: "0.001", routePlan: [], setupInstructions: [], swapInstruction: {},
      cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
    } as never));
    const { quote, legs } = await getOpenPositionQuoteBundle(wallet,
      { poolId, inputMint: mintA, inputKind: "token" }, "0.1", { preset: "standard" }, 9900, 100, 24, snapshot, "sequential");
    expect(legs[0]!.spend).toBe(100000n);
    expect(legs[1]!.inputMint).toBe(firstMint);
    expect(legs[0]!.minOut + legs[1]!.spend).toBe(99000n);
    expect(BigInt(quote.amountMaxA)).toBeLessThanOrEqual(legs[0]!.minOut);
    expect(BigInt(quote.amountMaxB)).toBeLessThanOrEqual(legs[1]!.minOut);
    expect(buildRoute).toHaveBeenCalledWith(wallet, firstMint, secondMint, expect.any(BigInt), false, 24);
    expect(vi.mocked(buildRoute).mock.calls.every(call => call[5] === 24 && call[4] === false)).toBe(true);
    expect(readOpenPoolState).not.toHaveBeenCalled();
  });

  it("rejects combined impact above 5% even when each sequential route reports less than 5%", async () => {
    const firstMint = Keypair.generate().publicKey.toBase58(), secondMint = Keypair.generate().publicKey.toBase58();
    const snapshot = state({ mintA: firstMint, mintB: secondMint, decimalsA: 6, decimalsB: 6,
      inputMint: mintA, inputDecimals: 6, fetchedAt: Date.now(), price: "1" });
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
      inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString(),
      otherAmountThreshold: spend.toString(), priceImpactPct: "0.03", routePlan: [],
    } as never));
    await expect(getOpenPositionQuoteBundle(wallet, { poolId, inputMint: mintA, inputKind: "token" },
      "0.1", { preset: "standard" }, 9900, 100, 24, snapshot, "sequential")).rejects.toThrow("Combined sequential swap price impact exceeds 5%");
  });

  it("does not extend the lifetime of a reused pool snapshot", async () => {
    const snapshot = state({ fetchedAt: Date.now() - 75001 });
    await expect(getOpenPositionQuoteBundle(wallet, { poolId, inputMint: mintA, inputKind: "token" },
      "0.1", { preset: "standard" }, 9900, 100, 24, snapshot)).rejects.toThrow("snapshot expired");
    expect(buildRoute).not.toHaveBeenCalled();
  });

  describe("protocol swap fee", () => {
    const feeWallet = Keypair.generate().publicKey.toBase58();
    const originalWallet = process.env.SOFINANCE_FEE_WALLET;
    const originalBps = process.env.SOFINANCE_FEE_BPS;
    afterEach(() => {
      if (originalWallet === undefined) delete process.env.SOFINANCE_FEE_WALLET;
      else process.env.SOFINANCE_FEE_WALLET = originalWallet;
      if (originalBps === undefined) delete process.env.SOFINANCE_FEE_BPS;
      else process.env.SOFINANCE_FEE_BPS = originalBps;
    });

    it("reduces executed Jupiter input by the fee and leaves resale probes uncharged", async () => {
      process.env.SOFINANCE_FEE_WALLET = feeWallet;
      process.env.SOFINANCE_FEE_BPS = "20";
      vi.mocked(readOpenPoolState).mockResolvedValue(state({ inputMint: mintB, inputDecimals: 9, inputKind: "token" }));
      vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => {
        const out = inputMint === mintB && outputMint === mintA ? spend / 1000n : spend;
        return {
          inputMint, outputMint, inAmount: spend.toString(), outAmount: out.toString(),
          otherAmountThreshold: out.toString(), swapMode: "ExactIn", slippageBps: 50,
          priceImpactPct: "0", routePlan: [], setupInstructions: [], swapInstruction: {},
          cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
        } as never;
      });
      const { quote, legs } = await getOpenPositionQuoteBundle(wallet,
        { poolId, inputMint: mintB, inputKind: "token" }, "0.1",
        { preset: "custom", minPrice: "1", maxPrice: "2" });
      expect(legs[0]?.spend).toBe(100_000_000n);
      expect(legs[0]?.feeAmount).toBe(200_000n);
      expect(quote.feeBps).toBe(20);
      expect(quote.feeAmount).toBe("200000");
      expect(quote.feeWallet).toBe(feeWallet);
      expect(quote.minOutA).toBe("99800");
      const swapCalls = vi.mocked(buildRoute).mock.calls.filter((call) => call[1] === mintB && call[2] === mintA);
      const resaleCalls = vi.mocked(buildRoute).mock.calls.filter((call) => call[1] === mintA && call[2] === mintB);
      expect(swapCalls.map((call) => call[3])).toEqual([9_980_000n, 99_800_000n]);
      expect(resaleCalls.map((call) => call[3])).toEqual([99_800n]);
    });

    it("does not charge a same-mint open that never swaps", async () => {
      process.env.SOFINANCE_FEE_WALLET = feeWallet;
      process.env.SOFINANCE_FEE_BPS = "20";
      const { quote, legs } = await getOpenPositionQuoteBundle(
        wallet,
        { poolId, inputMint: mintA, inputKind: "token" },
        "100",
        { preset: "custom", minPrice: "1", maxPrice: "2" },
      );
      expect(legs[0]?.route).toBeNull();
      expect(legs[0]?.feeAmount).toBe(0n);
      expect(quote.feeBps).toBe(20);
      expect(quote.feeAmount).toBe("0");
      expect(quote.feeWallet).toBe(feeWallet);
      expect(buildRoute).not.toHaveBeenCalled();
    });
  });

});
