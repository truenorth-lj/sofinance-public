/**
 * Integration tests for MCP tools
 * 
 * These tests verify the tool implementations work correctly with mocked dependencies.
 * Full end-to-end testing requires a live Solana RPC connection and real on-chain data.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock server-only module
vi.mock("server-only", () => ({}));

// Mock modules before importing tools
vi.mock("../lib/wallet-discovery", () => ({
  discoverWallet: vi.fn(),
}));

vi.mock("../lib/selected-quote", () => ({
  getSelectedQuoteBundle: vi.fn(),
}));

vi.mock("../lib/selected-atomic", () => ({
  buildAndSimulateSelectedZap: vi.fn(),
}));

vi.mock("../lib/compound-atomic", () => ({
  buildAndSimulateCompound: vi.fn(),
}));

vi.mock("../lib/selected-permit", () => ({
  issueSelectedPermit: vi.fn(() => "mock-permit"),
  verifySelectedPermit: vi.fn(() => true),
}));

vi.mock("../lib/compound-permit", () => ({
  issueCompoundPermit: vi.fn(() => "mock-compound-permit"),
  verifyCompoundPermit: vi.fn(() => true),
}));

vi.mock("../lib/open-quote", () => ({
  getOpenPositionQuoteBundle: vi.fn(),
}));

vi.mock("../lib/open-atomic", () => ({
  buildAndSimulateOpenPosition: vi.fn(),
}));

vi.mock("../lib/open-permit", () => ({
  issueOpenPositionPermit: vi.fn(() => "mock-open-permit"),
  verifyOpenPositionPermit: vi.fn(() => true),
}));

vi.mock("../lib/rwa-pairs", () => ({
  discoverRwaPairs: vi.fn(),
  getCachedRwaPairs: vi.fn(() => null),
}));

vi.mock("../lib/solami-blur", () => ({
  getPoolActivitySnapshot: vi.fn(),
}));

vi.mock("../lib/position-range-onchain", () => ({
  readPositionRangeFacts: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({
  rpcConnection: vi.fn(() => ({
    getBlockHeight: vi.fn(() => Promise.resolve(1000)),
    getBalance: vi.fn(() => Promise.resolve(1000000000)),
    sendRawTransaction: vi.fn((tx) => {
      // Mock returning the signature from the transaction
      return Promise.resolve(
        "mock-signature-" + Buffer.from(tx).slice(0, 8).toString("hex")
      );
    }),
  })),
}));

import {
  listPositions,
  quoteAddLiquidity,
  prepareTransaction,
  quoteCompound,
  prepareCompoundTransaction,
  quoteOpenPosition,
  prepareOpenPosition,
  listRwaPairs,
  getPoolActivity,
  getPositionRangeStatus,
} from "./tools";
import { discoverWallet } from "../lib/wallet-discovery";
import { getSelectedQuoteBundle } from "../lib/selected-quote";
import { buildAndSimulateSelectedZap } from "../lib/selected-atomic";
import { buildAndSimulateCompound } from "../lib/compound-atomic";
import { getOpenPositionQuoteBundle } from "../lib/open-quote";
import { buildAndSimulateOpenPosition } from "../lib/open-atomic";
import { discoverRwaPairs } from "../lib/rwa-pairs";
import { getPoolActivitySnapshot } from "../lib/solami-blur";
import { readPositionRangeFacts } from "../lib/position-range-onchain";

describe("MCP Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listPositions", () => {
    it("calls discoverWallet and returns formatted result", async () => {
      const mockDiscovery = {
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        slot: 12345,
        fetchedAt: Date.now(),
        positions: [
          {
            positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
            positionAccount: "9BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM5",
            poolId: "ABgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM6",
            mintA: "So11111111111111111111111111111111111111112",
            mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            decimalsA: 9,
            decimalsB: 6,
            feeTierBps: 1,
            symbolA: "WSOL",
            symbolB: "USDC",
            tickLower: -1000,
            tickUpper: 1000,
            tickCurrent: 0,
            rangeSide: "inside" as const,
            liquidity: "1000000",
          },
        ],
        assets: [
          {
            kind: "native" as const,
            mint: "So11111111111111111111111111111111111111112",
            tokenProgram: null,
            decimals: 9,
            balance: "1000000000",
            totalBalance: "1010000000",
            account: null,
            eligible: true,
            reason: null,
          },
        ],
      };

      vi.mocked(discoverWallet).mockResolvedValue(mockDiscovery);

      const result = await listPositions({
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
      });

      expect(result.wallet).toBe(mockDiscovery.wallet);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0]?.positionMint).toBe(
        mockDiscovery.positions[0]?.positionMint
      );
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0]?.kind).toBe("native");
    });

    it("propagates errors from discoverWallet", async () => {
      vi.mocked(discoverWallet).mockRejectedValue(
        new Error("Wallet scan failed")
      );

      await expect(
        listPositions({
          wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        })
      ).rejects.toThrow("Wallet scan failed");
    });
  });

  describe("quoteAddLiquidity", () => {
    it("calls getSelectedQuoteBundle and returns formatted quote", async () => {
      const mockQuote = {
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        inputMint: "So11111111111111111111111111111111111111112",
        inputKind: "native" as const,
        inputDecimals: 9,
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        positionAccount: "9BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM5",
        poolId: "ABgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM6",
        mintA: "So11111111111111111111111111111111111111112",
        mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimalsA: 9,
        decimalsB: 6,
        rangeSide: "inside" as const,
        requested: "1500000000",
        spendA: "750000000",
        spendB: "750000000",
        minOutA: "745000000",
        minOutB: "745000000",
        liquidity: "1000000",
        amountMaxA: "745000000",
        amountMaxB: "745000000",
        requiredA: "740000000",
        requiredB: "740000000",
        toleranceBps: 100,
        dustA: "0",
        dustB: "0",
        resaleInput: "1485000000",
        minimumResaleInput: "1485000000",
        roundtripCostInput: "15000000",
        projectedPrice: "1.0",
        passesFloor: true,
        floorBps: 9900,
        suggestedResaleFloorBps: 9900,
        maxAmountForFloor: "1500000000",
        achievedResaleBps: 9900,
        warning: "",
        maxImpactBps: 500,
        slippageBps: 50,
        routeTouchesTargetPool: false,
        expiresAt: Date.now() + 30000,
        fetchedAt: Date.now(),
        slot: 12345,
      };

      vi.mocked(getSelectedQuoteBundle).mockResolvedValue({
        quote: mockQuote,
        legs: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state: {} as any,
      });

      const result = await quoteAddLiquidity({
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        inputMint: "So11111111111111111111111111111111111111112",
        inputKind: "native",
        amount: "1.5",
        resaleFloorBps: 9900,
        slippageToleranceBps: 200,
      });

      expect(getSelectedQuoteBundle).toHaveBeenCalledWith(
        "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        expect.objectContaining({ inputKind: "native" }),
        "1.5",
        9900,
        200,
      );
      expect(result.slippageToleranceBps).toBe(100);
      expect(result.wallet).toBe(mockQuote.wallet);
      expect(result.requested).toBe(mockQuote.requested);
      expect(result.passesFloor).toBe(true);
    });
  });

  describe("prepareTransaction", () => {
    it("builds transaction and returns with permit", async () => {
      const mockSummary = {
        simulated: true,
        quote: {
          wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
          inputMint: "So11111111111111111111111111111111111111112",
          inputKind: "native" as const,
          inputDecimals: 9,
          positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
          positionAccount: "9BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM5",
          poolId: "ABgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM6",
          mintA: "So11111111111111111111111111111111111111112",
          mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          decimalsA: 9,
          decimalsB: 6,
          requested: "1500000000",
          spendA: "750000000",
          spendB: "750000000",
          minOutA: "745000000",
          minOutB: "745000000",
          liquidity: "1000000",
          amountMaxA: "745000000",
          amountMaxB: "745000000",
          requiredA: "740000000",
          requiredB: "740000000",
          toleranceBps: 100,
          dustA: "0",
          dustB: "0",
          resaleInput: "1485000000",
          minimumResaleInput: "1485000000",
          roundtripCostInput: "15000000",
          projectedPrice: "1.0",
          passesFloor: true,
          floorBps: 9900,
          suggestedResaleFloorBps: 9900,
          maxAmountForFloor: "1500000000",
          achievedResaleBps: 9900,
          warning: "",
          maxImpactBps: 500,
          slippageBps: 50,
          routeTouchesTargetPool: false,
          expiresAt: Date.now() + 30000,
          fetchedAt: Date.now(),
          slot: 12345,
          rangeSide: "inside" as const,
        },
        sizeBytes: 1200,
        unitsConsumed: 150000,
        feeLamports: 5000,
        lastValidBlockHeight: 1000000,
        blockhash: "mockhash",
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        positionAccount: "9BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM5",
        poolId: "ABgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM6",
        inputMint: "So11111111111111111111111111111111111111112",
        inputKind: "native" as const,
        startingLiquidity: "900000",
        simulatedEndingLiquidity: "1900000",
        simulatedInputSpent: "1500000000",
        simulatedDustA: "0",
        simulatedDustB: "0",
        simulatedSolDebitLamports: "1500005000",
        simulatedAt: Date.now(),
        expiresAt: Date.now() + 30000,
        startingBalances: {
          input: "5000000000",
          a: "1000000",
          b: "2000000",
        },
        beam: { included: false, tipLamports: 0, tipAddress: null, skippedReason: "disabled" as const },
      };

      const mockTransaction = {
        serialize: () => Buffer.from("mock-transaction"),
        message: {
          serialize: () => Buffer.from("mock-message"),
        },
      };

      vi.mocked(buildAndSimulateSelectedZap).mockResolvedValue({
        summary: mockSummary as typeof mockSummary & Record<string, unknown>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: mockTransaction as any,
      });

      const result = await prepareTransaction({
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        inputMint: "So11111111111111111111111111111111111111112",
        inputKind: "native",
        amount: "1.5",
        resaleFloorBps: 9900,
        slippageToleranceBps: 100,
      });

      expect(result.unsignedTransaction).toBeDefined();
      expect(result.permit).toBe("mock-permit");
      expect(result.summary.simulated).toBe(true);
      expect(result.instructions).toBeDefined();
      // submitArgs must carry every permit-bound field submit_signed_transaction needs
      expect(result.submitArgs).toEqual({
        permit: "mock-permit",
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        selection: {
          positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
          inputMint: "So11111111111111111111111111111111111111112",
          inputKind: "native",
        },
        requested: "1500000000",
        expectedLiquidity: "1000000",
        startingLiquidity: "900000",
        floorBps: 9900,
        expiresAt: mockSummary.expiresAt,
        lastValidBlockHeight: 1000000,
        rangeSide: "inside",
        startingBalances: { input: "5000000000", a: "1000000", b: "2000000" },
      });
    });
  });

  describe("quoteCompound", () => {
    it("builds compound quote and returns summary", async () => {
      const mockSummary = {
        operation: "compound",
        simulated: true,
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        positionAccount: "9BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM5",
        poolId: "ABgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM6",
        startingLiquidity: "900000",
        liquidity: "950000",
        amountMaxA: "100000",
        amountMaxB: "200000",
        swaps: [],
        simulatedHarvest: { a: "100000", b: "200000" },
        simulatedRewards: [],
        simulatedEndingLiquidity: "950000",
        simulatedDustA: "0",
        simulatedDustB: "0",
        simulatedSolDebitLamports: "10000",
        maxSolDebitLamports: "20000",
        feeLamports: 5000,
        rentLamports: 2000,
        sizeBytes: 1100,
        unitsConsumed: 140000,
        expiresAt: Date.now() + 30000,
        simulatedAt: Date.now(),
      };

      const mockTransaction = {
        serialize: () => Buffer.from("mock-compound-transaction"),
        message: {
          serialize: () => Buffer.from("mock-compound-message"),
        },
      };

      vi.mocked(buildAndSimulateCompound).mockResolvedValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summary: mockSummary as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: mockTransaction as any,
      });

      const result = await quoteCompound({
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
      });

      expect(result.operation).toBe("compound");
      expect(result.simulated).toBe(true);
      expect(result.liquidity).toBe("950000");
    });
  });

  describe("prepareCompoundTransaction", () => {
    it("builds compound transaction with permit", async () => {
      const mockSummary = {
        operation: "compound",
        simulated: true,
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        positionAccount: "9BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM5",
        poolId: "ABgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM6",
        startingLiquidity: "900000",
        liquidity: "950000",
        sizeBytes: 1100,
        feeLamports: 5000,
        expiresAt: Date.now() + 30000,
      };

      const mockTransaction = {
        serialize: () => Buffer.from("mock-compound-transaction"),
        message: {
          serialize: () => Buffer.from("mock-compound-message"),
        },
      };

      vi.mocked(buildAndSimulateCompound).mockResolvedValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summary: mockSummary as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: mockTransaction as any,
      });

      const result = await prepareCompoundTransaction({
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
      });

      expect(result.unsignedTransaction).toBeDefined();
      expect(result.permit).toBe("mock-compound-permit");
      expect(result.summary.operation).toBe("compound");
      // The permit covers the complete summary, so it must be returned unchanged
      expect(result.summary).toEqual(mockSummary);
      expect(result.instructions).toBeDefined();
    });
  });

  describe("listRwaPairs", () => {
    it("includes openPositionUrl and recommendedRanges on each pair", async () => {
      const poolId = "So11111111111111111111111111111111111111112";
      vi.mocked(discoverRwaPairs).mockResolvedValue({
        pairingRuleSummary: "rule",
        estimatedFeeAprLabel: "label",
        source: "raydium",
        fetchedAt: "now",
        scannedPools: 1,
        pagesFetched: 1,
        pairs: [{
          poolAddress: poolId,
          mintA: poolId,
          mintB: poolId,
          symbolA: "FOOx",
          symbolB: "FOO",
          nameA: "FOOx",
          nameB: "FOO",
          baseSymbol: "FOO",
          wrappedSymbol: "FOOx",
          plainSymbol: "FOO",
          wrapKind: "suffix-x",
          relatedness: "same-asset",
          qualificationA: "jupiter",
          qualificationB: "jupiter",
          preferredTags: true,
          jupiterTagsA: ["stocks"],
          jupiterTagsB: ["stocks"],
          feeRate: 0.0004,
          feeTierBps: 4,
          tvlUsd: 1,
          volume24hUsd: 1,
          fees24hUsd: 1,
          raydiumFeeApr24h: 1,
          estimatedFeeAprPct: 1,
          estimatedFeeAprLabel: "label",
          token2022A: false,
          token2022B: false,
          freezeRiskA: false,
          freezeRiskB: false,
          freezeRisk: false,
        }],
      } as never);

      const result = await listRwaPairs({ minTvl: 0, maxPages: 1, sortBy: "estimatedFeeApr" });
      expect(result.pairs[0]?.openPositionUrl).toContain(`/app/rwa-pairs?pool=${poolId}&open=1`);
      expect(result.pairs[0]?.recommendedRanges.some((item: { id: string }) => item.id === "standard")).toBe(true);
    });
  });

  describe("quoteOpenPosition", () => {
    it("returns the open-position quote", async () => {
      const poolId = "So11111111111111111111111111111111111111112";
      vi.mocked(getOpenPositionQuoteBundle).mockResolvedValue({
        quote: {
          wallet: "11111111111111111111111111111111",
          poolId,
          requested: "1000000",
          tickLower: -30,
          tickUpper: 30,
          rangeSide: "inside",
        },
        legs: [],
        state: {},
        range: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const result = await quoteOpenPosition({
        wallet: "11111111111111111111111111111111",
        poolId,
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputKind: "token",
        amount: "1",
        rangePreset: "standard",
        slippageToleranceBps: 100,
      });
      expect(result.poolId).toBe(poolId);
      expect(result.tickLower).toBe(-30);
    });
  });

  describe("prepareOpenPosition", () => {
    it("returns signUrl, permit, and summary for the new tx kind", async () => {
      process.env.JUPITER_API_KEY = "test-secret";
      const mockSummary = {
        operation: "open-position",
        simulated: true,
        nftMint: "11111111111111111111111111111112",
        poolId: "So11111111111111111111111111111111111111112",
        expiresAt: Date.now() + 30000,
        quote: { requested: "1000000", liquidity: "10" },
      };
      const mockTransaction = {
        serialize: () => Buffer.from("mock-open-transaction"),
        message: { serialize: () => Buffer.from("mock-open-message") },
      };
      vi.mocked(buildAndSimulateOpenPosition).mockResolvedValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summary: mockSummary as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: mockTransaction as any,
      });

      const result = await prepareOpenPosition({
        wallet: "11111111111111111111111111111111",
        poolId: "So11111111111111111111111111111111111111112",
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputKind: "token",
        amount: "1",
        rangePreset: "standard",
        slippageToleranceBps: 100,
      });

      expect(result.permit).toBe("mock-open-permit");
      expect(result.signUrl).toContain("/app/sign/");
      expect(result.summary).toEqual(mockSummary);
      expect(result.unsignedTransaction).toBeDefined();
    });
  });

  describe("getPoolActivity", () => {
    it("returns the Blur snapshot from the shared client", async () => {
      vi.mocked(getPoolActivitySnapshot).mockResolvedValue({
        available: true,
        poolId: "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro",
        pool: null,
        trades: [],
        fetchedAt: "2026-10-10T00:00:00.000Z",
        source: "solami-blur",
      });
      const result = await getPoolActivity({
        poolId: "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro",
        limit: 10,
      });
      expect(result.available).toBe(true);
      expect(getPoolActivitySnapshot).toHaveBeenCalledWith(
        "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro",
        { limit: 10 },
      );
    });
  });

  describe("getPositionRangeStatus", () => {
    it("uses Blur price when present and reports in-range", async () => {
      vi.mocked(readPositionRangeFacts).mockResolvedValue({
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        poolId: "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro",
        mintA: "MintA1111111111111111111111111111111111111",
        mintB: "MintB1111111111111111111111111111111111111",
        decimalsA: 6,
        decimalsB: 6,
        tickLower: -100,
        tickUpper: 100,
        tickCurrent: 0,
        onChainPriceBPerA: 1,
      });
      vi.mocked(getPoolActivitySnapshot).mockResolvedValue({
        available: true,
        poolId: "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro",
        pool: {
          pool: "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro",
          dex: "raydium_clmm",
          mint: "MintA1111111111111111111111111111111111111",
          quoteMint: "MintB1111111111111111111111111111111111111",
          name: null,
          symbol: null,
          price: 1,
          priceUsd: 1,
          baseReserve: null,
          quoteReserve: null,
          liquidityUsd: 1,
          tvlUsd: 1,
          fees24hUsd: null,
          volumeTvlRatio: null,
          lpDeposit24hUsd: null,
          lpWithdraw24hUsd: null,
        },
        trades: [],
        fetchedAt: "2026-10-10T00:00:00.000Z",
        source: "solami-blur",
      });
      const result = await getPositionRangeStatus({
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
      });
      expect(result.inRange).toBe(true);
      expect(result.priceSource).toBe("solami-blur");
      expect(result.blurAvailable).toBe(true);
    });
  });
});
