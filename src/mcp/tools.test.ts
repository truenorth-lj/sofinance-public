/**
 * Integration tests for MCP tools
 * 
 * These tests verify the tool implementations work correctly with mocked dependencies.
 * Full end-to-end testing requires a live Solana RPC connection and real on-chain data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nacl from "tweetnacl";

// Mock server-only module
vi.mock("server-only", () => ({}));

// Mock modules before importing tools
vi.mock("@sofinance/engine/wallet-discovery", () => ({
  discoverWallet: vi.fn(),
}));

vi.mock("../lib/selected-quote", () => ({
  searchSelectedQuoteBundle: vi.fn(),
}));

vi.mock("../lib/selected-atomic", () => ({
  buildAndSimulateSelectedZap: vi.fn(),
}));

vi.mock("@sofinance/engine/compound-atomic", () => ({
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

vi.mock("@sofinance/engine/open-quote", () => ({
  getOpenPositionQuoteBundle: vi.fn(),
}));

vi.mock("@sofinance/engine/open-atomic", () => ({
  buildAndSimulateOpenPosition: vi.fn(),
}));

vi.mock("../lib/open-permit", () => ({
  issueOpenPositionPermit: vi.fn(() => "mock-open-permit"),
  verifyOpenPositionPermit: vi.fn(() => true),
}));

vi.mock("../lib/rwa-pairs", () => ({
  RAYDIUM_API_V3: "https://api-v3.raydium.io",
  discoverRwaPairs: vi.fn(),
  getCachedRwaPairs: vi.fn(() => null),
}));

vi.mock("../lib/orca-positions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/orca-positions")>()),
  readOrcaPositionRangeFacts: vi.fn(async () => null),
}));
vi.mock("../lib/position-range-onchain", () => ({
  readPositionRangeFacts: vi.fn(),
}));

vi.mock("@sofinance/engine/rpc", () => ({
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
  getPositionRangeStatus,
} from "./tools";
import { discoverWallet } from "@sofinance/engine/wallet-discovery";
import { issueSelectedPermit } from "../lib/selected-permit";
import { issueCompoundPermit } from "../lib/compound-permit";
import { issueOpenPositionPermit } from "../lib/open-permit";
import { searchSelectedQuoteBundle } from "../lib/selected-quote";
import { buildAndSimulateSelectedZap } from "../lib/selected-atomic";
import { buildAndSimulateCompound } from "@sofinance/engine/compound-atomic";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { buildAndSimulateOpenPosition } from "@sofinance/engine/open-atomic";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";
import { discoverRwaPairs } from "../lib/rwa-pairs";
import { readPositionRangeFacts } from "../lib/position-range-onchain";

describe("MCP Tools", () => {
  beforeEach(() => {
    vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "false");
    vi.clearAllMocks();
    // The permit secret is read through lib/config/server-env: pin it so the tests prove it reaches the issuers.
    vi.stubEnv("JUPITER_API_KEY", "tools-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
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
    it("calls searchSelectedQuoteBundle and returns formatted quote", async () => {
      const mockQuote = {
        feeBps: 0, feeAmount: "0", feeWallet: null,
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

      vi.mocked(searchSelectedQuoteBundle).mockResolvedValue({
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

      expect(searchSelectedQuoteBundle).toHaveBeenCalledWith(
        "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        expect.objectContaining({ inputKind: "native" }),
        "1.5",
        9900,
        200,
        { buildTransactions: false, includeResale: false },
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
          feeBps: 0, feeAmount: "0", feeWallet: null,
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
      expect(vi.mocked(issueSelectedPermit).mock.calls[0]?.[0]).toBe("tools-secret");
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
      expect(vi.mocked(issueCompoundPermit).mock.calls[0]?.[0]).toBe("tools-secret");
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
        resaleFloorBps: 9900,
        slippageToleranceBps: 100,
      });
      expect(result.poolId).toBe(poolId);
      expect(result.tickLower).toBe(-30);
      expect(getOpenPositionQuoteBundle).toHaveBeenCalledWith(
        "11111111111111111111111111111111",
        { poolId, inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", inputKind: "token" },
        "1",
        { preset: "standard" },
        9900,
        100,
      );
    });
  });

  describe("prepareOpenPosition", () => {
    it("returns signUrl, permit, and summary for the new tx kind", async () => {
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
        resaleFloorBps: 9800,
        slippageToleranceBps: 100,
        nftMint: "11111111111111111111111111111112",
      });
      expect(buildAndSimulateOpenPosition).toHaveBeenCalledWith(
        "11111111111111111111111111111111",
        {
          poolId: "So11111111111111111111111111111111111111112",
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputKind: "token",
        },
        "1",
        { preset: "standard" },
        9800,
        100,
        { nftMint: "11111111111111111111111111111112" },
      );

      expect(result.permit).toBe("mock-open-permit");
      expect(vi.mocked(issueOpenPositionPermit).mock.calls[0]?.[0]).toBe("tools-secret");
      expect(result.signUrl).toContain("/app/sign/");
      expect(result.summary).toEqual(mockSummary);
      expect(result.unsignedTransaction).toBeDefined();
      expect(result.instructions.message).toContain("wallet FIRST");
    });

    it("without nftMint uses a secret-less placeholder mint and leaves the preview fully unsigned", async () => {
      const keyPair = vi.spyOn(nacl.sign, "keyPair");
      const generate = vi.spyOn(Keypair, "generate");
      vi.mocked(buildAndSimulateOpenPosition).mockImplementation(async (...args: unknown[]) => {
        const mint = new PublicKey((args[6] as { nftMint: string }).nftMint);
        return {
          summary: { operation: "open-position", simulated: true, nftMint: mint.toBase58(), poolId: "So11111111111111111111111111111111111111112",
            expiresAt: Date.now() + 30000, quote: { requested: "1000000", liquidity: "10" } } as never,
          transaction: buildTransaction({ payer: testKeypair(1), extraSigners: [{ publicKey: mint } as Keypair], signWith: [] }),
        };
      });
      try {
        const result = await prepareOpenPosition({
          wallet: "11111111111111111111111111111111",
          poolId: "So11111111111111111111111111111111111111112",
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputKind: "token",
          amount: "1",
          rangePreset: "standard",
          resaleFloorBps: 9800,
          slippageToleranceBps: 100,
        });
        expect(buildAndSimulateOpenPosition).toHaveBeenCalledWith(
          "11111111111111111111111111111111",
          expect.any(Object),
          "1",
          { preset: "standard" },
          9800,
          100,
          expect.objectContaining({ nftMint: expect.any(String) }),
        );
        const tx = VersionedTransaction.deserialize(Buffer.from(result.unsignedTransaction, "base64"));
        expect(tx.signatures.every((sig) => sig.every((byte) => byte === 0))).toBe(true);
        expect(Object.keys(result).sort()).toEqual(["instructions", "permit", "signToken", "signUrl", "summary", "unsignedTransaction"]);
        expect(result.instructions.message).toContain("open signUrl");
        expect(keyPair).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
      } finally {
        keyPair.mockRestore();
        generate.mockRestore();
      }
    });
  });

  describe("getPositionRangeStatus", () => {
    it("uses the on-chain price and never makes a network request beyond the position read", async () => {
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
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const result = await getPositionRangeStatus({ positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4" });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.priceSource).toBe("on-chain");
        expect(result.priceBPerA).toBe(1);
        expect(result.inRange).toBe(true);
        expect(result).not.toHaveProperty("blurAvailable");
        expect(result).not.toHaveProperty("latestTrades");
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
