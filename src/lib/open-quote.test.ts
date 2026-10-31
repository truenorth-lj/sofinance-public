import BN from "bn.js";
import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import { Keypair } from "@solana/web3.js";
import { TickUtil, SqrtPriceMath } from "@raydium-io/raydium-sdk-v2";
import { uiPriceBPerAFromTick } from "@sofinance/engine/position-performance-math";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("@sofinance/engine/swap/jupiter", () => ({ buildRoute: vi.fn(), quoteRoute: vi.fn() }));
vi.mock("@sofinance/engine/open-rent", () => ({
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
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));

import { readOpenPoolState, type OpenPoolState } from "@sofinance/engine/open-state";
import { buildRoute, quoteRoute } from "@sofinance/engine/swap/jupiter";
import { estimateOpenPositionRent } from "@sofinance/engine/open-rent";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { runWithJupiterRelay } from "@sofinance/engine/jupiter/relay";

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
  // Sizing and resale are quote-only; each test's route fixture lives on the buildRoute mock.
  vi.mocked(quoteRoute).mockImplementation(async (inputMint, outputMint, amount, constraints, _signal, _budget, platformFeeBps) =>
    await vi.mocked(buildRoute).getMockImplementation()!(wallet, inputMint, outputMint, amount, false, constraints, undefined, undefined, undefined, platformFeeBps) as never);
});

const quotedAmounts = (inputMint: string, outputMint: string) =>
  vi.mocked(quoteRoute).mock.calls.filter(call => call[0] === inputMint && call[1] === outputMint).map(call => call[2]);
const builtAmounts = (inputMint: string, outputMint: string) =>
  vi.mocked(buildRoute).mock.calls.filter(call => call[1] === inputMint && call[2] === outputMint).map(call => call[3]);

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
    )).rejects.toThrow(/^Not enough USDC \(you have [0-9.,]+, entered [0-9.,]+\)$/);
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

  it("sizes from the pool price without probe quotes and builds the final leg from its own quote", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ inputMint: mintB, inputDecimals: 9, inputKind: "token" }));
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
      inputMint, outputMint, inAmount: spend.toString(), outAmount: (spend / 1000n).toString(),
      otherAmountThreshold: (spend / 1000n).toString(), swapMode: "ExactIn", slippageBps: 50,
      priceImpactPct: "0", routePlan: [], setupInstructions: [], swapInstruction: {},
      cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
    }) as never);
    const { legs } = await getOpenPositionQuoteBundle(wallet,
      { poolId, inputMint: mintB, inputKind: "token" }, "0.1", { preset: "custom", minPrice: "1", maxPrice: "2" });
    // Own-pool attempt (fixture is not an own-pool route) then the free route; no 1/10 probes.
    expect(quotedAmounts(mintB, mintA)).toEqual([100_000_000n, 100_000_000n]);
    expect(builtAmounts(mintB, mintA)).toEqual([100_000_000n]);
    const quoted = await vi.mocked(quoteRoute).mock.results[1]!.value;
    expect(vi.mocked(buildRoute).mock.calls[0]![11]).toBe(quoted);
    expect(legs[0]!.minOut).toBe(100_000n);
  });

  it("restarts sizing from the relay hint so pool drift between relay rounds reuses fetched quotes", async () => {
    const twoLeg = state({ inputMint: Keypair.generate().publicKey.toBase58(), decimalsB: 6, price: "1" });
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
      inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString(),
      otherAmountThreshold: spend.toString(), swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0", routePlan: [],
    }) as never);
    const run = (hints?: Map<string, string>) => runWithJupiterRelay(new Map(), () => getOpenPositionQuoteBundle(wallet,
      { poolId, inputMint: twoLeg.inputMint, inputKind: "token" }, "1", { preset: "standard" },
      9900, 100, 48, twoLeg, "parallel", { build: false }), hints);
    const first = await run();
    const [key, converged] = Object.entries(first.hints)[0]!;
    expect(key).toMatch(/^open:parallel:/);
    vi.mocked(quoteRoute).mockClear();
    await run(new Map([[key, "400000"]]));
    expect(vi.mocked(quoteRoute).mock.calls[0]![2]).toBe(400000n);
    expect(BigInt(converged)).toBeGreaterThan(0n);
  });

  it("settles a 0.5% allocation wobble instead of throwing", async () => {
    const twoLeg = state({ inputMint: Keypair.generate().publicKey.toBase58(), decimalsB: 6, price: "1" });
    let n = 0;
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => {
      n += 1;
      const out = n % 2 === 0 ? spend * 995n / 1000n : spend;
      return {
        inputMint, outputMint, inAmount: spend.toString(), outAmount: out.toString(),
        otherAmountThreshold: out.toString(), swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0", routePlan: [],
      } as never;
    });
    const { quote } = await getOpenPositionQuoteBundle(wallet,
      { poolId, inputMint: twoLeg.inputMint, inputKind: "token" }, "1", { preset: "standard" },
      9900, 100, 48, twoLeg, "parallel", { build: false });
    expect(BigInt(quote.spendA) + BigInt(quote.spendB)).toBe(BigInt(quote.requested));
    expect(BigInt(quote.spendA)).toBeLessThanOrEqual(BigInt(quote.requested));
  });

  it("skips swap-instructions entirely for a preview (build: false)", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(state({ inputMint: mintB, inputDecimals: 9, inputKind: "token" }));
    vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
      inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString(),
      otherAmountThreshold: spend.toString(), swapMode: "ExactIn", slippageBps: 50,
      priceImpactPct: "0", routePlan: [],
    }) as never);
    await getOpenPositionQuoteBundle(wallet, { poolId, inputMint: mintB, inputKind: "token" }, "0.1",
      { preset: "custom", minPrice: "1", maxPrice: "2" }, undefined, undefined, 48, undefined, "parallel", { build: false });
    expect(buildRoute).not.toHaveBeenCalled();
    expect(quoteRoute).toHaveBeenCalledTimes(3);
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
    // Sizing (own-pool attempt + free route) and one resale quote; only the deposit leg is built.
    expect(quoteRoute).toHaveBeenCalledTimes(3);
    expect(buildRoute).toHaveBeenCalledTimes(1);
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
    expect(quoteRoute).toHaveBeenCalledWith(primaryMint, secondaryMint, expect.any(BigInt), { maxAccounts: 20, onlyDirectRoutes: true, dexes: "Raydium CLMM" }, undefined, undefined, 0);
    expect(vi.mocked(quoteRoute).mock.calls.every(call => [20, 24].includes(call[3]!.maxAccounts))).toBe(true);
    // Exactly the two converged legs are built, each from its own sizing quote.
    expect(buildRoute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildRoute).mock.calls.every(call => call[4] === false && call[11] !== undefined)).toBe(true);
    const sqrt = SqrtPriceMath.getNextSqrtPriceFromInput(new BN(snapshot.sqrtPriceX64),
      new BN(snapshot.poolLiquidity), new BN(legs[1]!.route!.inAmount), strategy === "sequential");
    expect(quote.routeTouchesTargetPool).toBe(true);
    expect(quote.projectedPrice).toBe(TickUtil.sqrtPriceX64ToPrice(sqrt, 6, 6).toString());
    expect(readOpenPoolState).not.toHaveBeenCalled();
  });

  describe("target-pool projection on a wide tick spacing", () => {
    const firstMint = Keypair.generate().publicKey.toBase58(), secondMint = Keypair.generate().publicKey.toBase58();
    const snapshot = (poolLiquidity: string) => state({ mintA: firstMint, mintB: secondMint, decimalsA: 6, decimalsB: 6,
      inputMint: mintA, inputDecimals: 6, fetchedAt: Date.now(), price: "1", tickCurrent: 10, tickSpacing: 60, poolLiquidity,
      sqrtPriceX64: TickUtil.getSqrtPriceAtTick(10).add(TickUtil.getSqrtPriceAtTick(11)).divn(2).toString() });
    beforeEach(() => {
      vi.mocked(buildRoute).mockImplementation(async (_wallet, inputMint, outputMint, spend) => ({
        inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString(),
        otherAmountThreshold: (spend * 99n / 100n).toString(), swapMode: "ExactIn", slippageBps: 50,
        priceImpactPct: "0.001", routePlan: inputMint === mintA || outputMint === mintA ? [] : [{ percent: 100, bps: 10000,
          swapInfo: { ammKey: poolId, inputMint, outputMint, inAmount: spend.toString(), outAmount: spend.toString() } }], setupInstructions: [], swapInstruction: {},
        cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
      } as never));
    });

    it.each(["sequential", "sequential-b"] as const)("accepts a %s own-pool hop that moves several raw ticks but stays in the spacing band", async strategy => {
      const pool = snapshot("200000000");
      const { quote } = await getOpenPositionQuoteBundle(wallet,
        { poolId, inputMint: mintA, inputKind: "token" }, "0.1", { preset: "standard" }, 9900, 100, 24, pool, strategy);
      const projectedTick = TickUtil.getTickAtSqrtPrice(TickUtil.priceToSqrtPriceX64(new Decimal(quote.projectedPrice), 6, 6));
      expect(quote.routeTouchesTargetPool).toBe(true);
      expect(projectedTick).not.toBe(10);
      expect(projectedTick).toBeGreaterThanOrEqual(0);
      expect(projectedTick).toBeLessThan(60);
    });

    it("rejects a hop that leaves the spacing band while still inside the selected range", async () => {
      await expect(getOpenPositionQuoteBundle(wallet,
        { poolId, inputMint: mintA, inputKind: "token" }, "0.1", { preset: "standard" }, 9900, 100, 24, snapshot("20000000"), "sequential"))
        .rejects.toThrow(/tick-spacing boundary/);
    });
  });

  it.each(["sequential", "sequential-b"] as const)("charges the %s deposit once in the input mint", async strategy => {
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
    expect(legs[0]!.feeAmount).toBe(1000n);
    expect(legs[1]!.feeAmount).toBe(0n);
    for (const leg of legs) {
      // The fee is taken from the full leg spend inside the Jupiter swap.
      expect(BigInt(leg.route!.inAmount)).toBe(leg.spend);
    }
    expect(quote.feeBps).toBe(10);
    expect(quote.feeAmount).toBe("1000");
    expect(quote.feeWallet).toBe(feeWallet.toBase58());
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
    it("takes 10 bps of the input token and leaves resale probes uncharged", async () => {
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
      expect(legs[0]?.feeAmount).toBe(100_000n);
      expect(quote.feeBps).toBe(10);
      expect(quote.feeAmount).toBe("100000");
      expect(quote.feeWallet).toBe(feeWallet);
      // Jupiter swaps the full leg and deducts the fee in the input mint itself.
      expect(quote.minOutA).toBe("100000");
      expect(quotedAmounts(mintB, mintA)).toEqual([100_000_000n, 100_000_000n]);
      expect(builtAmounts(mintB, mintA)).toEqual([100_000_000n]);
      expect(quotedAmounts(mintA, mintB)).toEqual([100_000n]);
      expect(builtAmounts(mintA, mintB)).toEqual([]);
      // Deposit quotes carry the 10 bps Jupiter platform fee; resale quotes stay uncharged.
      expect(vi.mocked(quoteRoute).mock.calls.find(call => call[0] === mintB)![6]).toBe(10);
      expect(vi.mocked(quoteRoute).mock.calls.find(call => call[0] === mintA)![6]).toBe(0);
    });

    it("does not charge the unswapped part of a same-mint USDC open", async () => {
      vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet);
      vi.stubEnv("SOFINANCE_FEE_BPS", undefined);
      const { quote, legs } = await getOpenPositionQuoteBundle(
        wallet,
        { poolId, inputMint: mintA, inputKind: "token" },
        "100",
        { preset: "custom", minPrice: "1", maxPrice: "2" },
      );
      // The unswapped part of a same-mint open is not charged.
      expect(legs[0]?.route).toBeNull();
      expect(legs[0]?.feeAmount).toBe(0n);
      expect(quote.feeBps).toBe(10);
      expect(quote.feeAmount).toBe("0");
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
      expect(quotedAmounts(mintB, mintA)).toEqual([999n, 999n]);
      expect(builtAmounts(mintB, mintA)).toEqual([999n]);
    });
  });

});
