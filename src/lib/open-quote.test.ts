import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
