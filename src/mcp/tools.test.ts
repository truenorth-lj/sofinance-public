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
} from "./tools";
import { discoverWallet } from "../lib/wallet-discovery";
import { getSelectedQuoteBundle } from "../lib/selected-quote";
import { buildAndSimulateSelectedZap } from "../lib/selected-atomic";
import { buildAndSimulateCompound } from "../lib/compound-atomic";

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
        dustA: "0",
        dustB: "0",
        resaleInput: "1485000000",
        minimumResaleInput: "1485000000",
        roundtripCostInput: "15000000",
        projectedPrice: "1.0",
        passesFloor: true,
        floorBps: 9900,
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
      });

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
          dustA: "0",
          dustB: "0",
          resaleInput: "1485000000",
          minimumResaleInput: "1485000000",
          roundtripCostInput: "15000000",
          projectedPrice: "1.0",
          passesFloor: true,
          floorBps: 9900,
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
      });

      expect(result.unsignedTransaction).toBeDefined();
      expect(result.permit).toBe("mock-permit");
      expect(result.summary.simulated).toBe(true);
      expect(result.instructions).toBeDefined();
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
      expect(result.instructions).toBeDefined();
    });
  });
});
