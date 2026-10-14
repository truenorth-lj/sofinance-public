import BN from "bn.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { rpcConnection } from "./rpc";
import { Keypair } from "@solana/web3.js";
import { TickUtil, SqrtPriceMath } from "@raydium-io/raydium-sdk-v2";
import { uiPriceBPerAFromTick } from "./position-performance-math";

vi.mock("server-only", () => ({}));
vi.mock("./open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("./swap/jupiter", () => ({ buildRoute: vi.fn() }));
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
import { buildRoute } from "./swap/jupiter";
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
    inputKind: "token", inputMint: mintA, inputDecimals: 6, inputTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    inputAccount: Keypair.generate().publicKey.toBase58(), inputBalance: "1000000000",
    mintA, mintB, decimalsA: 6, decimalsB: 9, programA: TOKEN_PROGRAM_ID.toBase58(), programB: TOKEN_PROGRAM_ID.toBase58(),
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
  // Hermetic: ambient fee/key env must not change quote math.
  vi.stubEnv("SOFINANCE_FEE_WALLET", undefined);
  vi.stubEnv("SOFINANCE_FEE_BPS", undefined);
  vi.stubEnv("JUPITER_API_KEY", undefined);
  vi.mocked(rpcConnection).mockReturnValue({ getAccountInfo: vi.fn(async (address: PublicKey) => {
    const data = Buffer.alloc(165);
    AccountLayout.encode({ mint: [mintA, mintB].map(m => new PublicKey(m)).find(m => getAssociatedTokenAddressSync(m, new PublicKey(process.env.SOFINANCE_FEE_WALLET!), true).equals(address))!, owner: new PublicKey(process.env.SOFINANCE_FEE_WALLET!),
      amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
      isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return { data, owner: TOKEN_PROGRAM_ID, lamports: 2039280, executable: false, rentEpoch: 0 };
  }) } as never);
  vi.mocked(readOpenPoolState).mockResolvedValue(state());
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(buildRoute).toHaveBeenCalledTimes(5);
  });
  it.each(["sequential", "sequential-b"] as const)("sizes %s LP from conservative primary output and tries compact own-pool routes for secondary probes and swaps", async strategy => {
    const firstMint = Keypair.generate().publicKey.toBase58(), secondMint = Keypair.generate().publicKey.toBase58();
    const snapshot = state({ mintA: firstMint, mintB: secondMint, decimalsA: 6, decimalsB: 6,
      inputMint: mintA, inputDecimals: 6, fetchedAt: Date.now(), price: "1", tickCurrent: 10,
      sqrtPriceX64: TickUtil.getSqrtPriceAtTick(10).add(TickUtil.getSqrtPriceAtTick(11)).divn(2).toString() });
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
      inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString(),
      otherAmountThreshold: (spend * 99n / 100n).toString(), swapMode: "ExactIn", slippageBps: 50,
      priceImpactPct: "0.001", routePlan: inputMint === mintA || outputMint === mintA ? [] : [{ percent: 100, bps: 10000,
        swapInfo: { ammKey: poolId, inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString() } }], setupInstructions: [], swapInstruction: {},
      cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
    } as never));
    const { quote, legs } = await getOpenPositionQuoteBundle(wallet,
      { poolId, inputMint: mintA, inputKind: "token" }, "0.1", { preset: "standard" }, 9900, 100, 24, snapshot, strategy);
    const primaryMint = strategy === "sequential" ? firstMint : secondMint;
    const secondaryMint = strategy === "sequential" ? secondMint : firstMint;
    expect(legs[0]!.spend).toBe(100000n);
    expect(legs[1]!.inputMint).toBe(primaryMint);
    expect(legs[0]!.minOut + legs[1]!.spend).toBe(99000n);
    expect(BigInt(quote.amountMaxA)).toBeLessThanOrEqual(legs.find(leg => leg.outputMint === firstMint)!.minOut);
    expect(BigInt(quote.amountMaxB)).toBeLessThanOrEqual(legs.find(leg => leg.outputMint === secondMint)!.minOut);
    expect(buildRoute).toHaveBeenCalledWith(wallet, primaryMint, secondaryMint, expect.any(BigInt), false, { maxAccounts: 20, onlyDirectRoutes: true, dexes: "Raydium CLMM" }, undefined, undefined, undefined, 0);
    expect(vi.mocked(buildRoute).mock.calls.every(call => typeof call[5] === "object" && [20, 24].includes(call[5].maxAccounts) && call[4] === false)).toBe(true);
    const sqrt = SqrtPriceMath.getNextSqrtPriceFromInput(new BN(snapshot.sqrtPriceX64),
      new BN(snapshot.poolLiquidity), new BN(legs[1]!.route!.inAmount), strategy === "sequential");
    expect(quote.routeTouchesTargetPool).toBe(true);
    expect(quote.projectedPrice).toBe(TickUtil.sqrtPriceX64ToPrice(sqrt, 6, 6).toString());
    expect(readOpenPoolState).not.toHaveBeenCalled();
  });

  it.each(["sequential", "sequential-b"] as const)("charges both %s swap legs in their own input mint", async strategy => {
    const feeWallet = Keypair.generate().publicKey;
    vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet.toBase58());
    const snapshot = state({ inputMint: Keypair.generate().publicKey.toBase58(), price: "1", decimalsB: 6 });
    vi.mocked(rpcConnection).mockReturnValue({ getAccountInfo: vi.fn(async (address: PublicKey) => {
      const mint = [snapshot.inputMint, snapshot.mintA, snapshot.mintB].map(m => new PublicKey(m)).find(m =>
        getAssociatedTokenAddressSync(m, feeWallet, true).equals(address))!;
      const data = Buffer.alloc(165);
      AccountLayout.encode({ mint, owner: feeWallet, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
        state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
      return { data, owner: TOKEN_PROGRAM_ID };
    }) } as never);
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, amount) => ({
      inputMint, outputMint, inAmount: amount.toString(), outAmount: amount.toString(),
      otherAmountThreshold: amount.toString(), priceImpactPct: "0", routePlan: [],
    }) as never);
    const { quote, legs } = await getOpenPositionQuoteBundle(wallet,
      { poolId, inputMint: snapshot.inputMint, inputKind: "token" }, "1", { preset: "standard" },
      9900, 100, 24, snapshot, strategy);
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      expect(leg.feeAmount).toBe(leg.outputMint === mintA ? 0n : leg.spend * 10n / 10000n);
      expect(BigInt(leg.route!.inAmount)).toBe(leg.spend - leg.feeAmount);
    }
    expect(quote.swapFees!.map(fee => fee.mint)).toEqual(legs.map(leg => leg.inputMint));
    expect(quote.feeAmount).toBe(legs[0]!.feeAmount.toString());
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
    it("uses output USDC platform fees and leaves resale probes uncharged", async () => {
      vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet);
      vi.stubEnv("SOFINANCE_FEE_BPS", undefined);
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
      expect(legs[0]?.feeAmount).toBe(0n);
      expect(quote.feeBps).toBe(10);
      expect(quote.feeAmount).toBe("0");
      expect(quote.feeWallet).toBe(feeWallet);
      expect(quote.minOutA).toBe("100000");
      const swapCalls = vi.mocked(buildRoute).mock.calls.filter((call) => call[1] === mintB && call[2] === mintA);
      const resaleCalls = vi.mocked(buildRoute).mock.calls.filter((call) => call[1] === mintA && call[2] === mintB);
      expect(swapCalls.map((call) => call[3])).toEqual([10_000_000n, 10_000_000n, 100_000_000n, 100_000_000n]);
      expect(resaleCalls.map((call) => call[3])).toEqual([100_000n]);
    });

    it("takes the USDC deposit fee even for a same-mint open", async () => {
      vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet);
      vi.stubEnv("SOFINANCE_FEE_BPS", undefined);
      const { quote, legs } = await getOpenPositionQuoteBundle(
        wallet,
        { poolId, inputMint: mintA, inputKind: "token" },
        "100",
        { preset: "custom", minPrice: "1", maxPrice: "2" },
      );
      expect(legs[0]?.route).toBeNull();
      expect(legs[0]?.feeAmount).toBe(100000n);
      expect(quote.feeBps).toBe(10);
      expect(quote.feeAmount).toBe("100000");
      expect(quote.feeWallet).toBe(feeWallet);
      expect(buildRoute).not.toHaveBeenCalled();
    });

    it("floors a tiny swap to fee 0 and still quotes the full Jupiter amount", async () => {
      vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet);
      vi.stubEnv("SOFINANCE_FEE_BPS", undefined);
      vi.mocked(readOpenPoolState).mockResolvedValue(state({ inputMint: mintB, inputDecimals: 9, inputKind: "token" }));
      vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
        inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString(),
        otherAmountThreshold: spend.toString(), swapMode: "ExactIn", slippageBps: 50,
        priceImpactPct: "0", routePlan: [], setupInstructions: [], swapInstruction: {},
        cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
      } as never));
      const { quote, legs } = await getOpenPositionQuoteBundle(wallet,
        { poolId, inputMint: mintB, inputKind: "token" }, "0.000000999",
        { preset: "custom", minPrice: "1", maxPrice: "2" });
      expect(legs[0]?.spend).toBe(999n);
      expect(legs[0]?.feeAmount).toBe(0n);
      expect(quote.feeBps).toBe(10);
      expect(quote.feeAmount).toBe("0");
      expect(quote.feeWallet).toBe(feeWallet);
      expect(vi.mocked(buildRoute).mock.calls.filter((call) => call[1] === mintB).map((call) => call[3]))
        .toEqual([99n, 99n, 999n, 999n]);
    });
  });

});
