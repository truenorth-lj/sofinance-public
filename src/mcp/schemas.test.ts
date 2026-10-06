import { describe, it, expect } from "vitest";
import {
  listPositionsSchema,
  quoteAddLiquiditySchema,
  prepareTransactionSchema,
  quoteCompoundSchema,
  submitSignedTransactionSchema,
  submitCompoundTransactionSchema,
} from "./schemas";

describe("MCP Schemas", () => {
  describe("listPositionsSchema", () => {
    it("validates correct wallet address", () => {
      const result = listPositionsSchema.safeParse({
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid wallet address", () => {
      const result = listPositionsSchema.safeParse({
        wallet: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing wallet", () => {
      const result = listPositionsSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("quoteAddLiquiditySchema", () => {
    const validInput = {
      wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
      positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
      inputMint: "So11111111111111111111111111111111111111112",
      inputKind: "native" as const,
      amount: "1.5",
    };

    it("validates correct input", () => {
      const result = quoteAddLiquiditySchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("applies default resaleFloorBps", () => {
      const result = quoteAddLiquiditySchema.parse(validInput);
      expect(result.resaleFloorBps).toBe(9900);
    });

    it("accepts custom resaleFloorBps", () => {
      const result = quoteAddLiquiditySchema.parse({
        ...validInput,
        resaleFloorBps: 9800,
      });
      expect(result.resaleFloorBps).toBe(9800);
    });

    it("rejects resaleFloorBps out of range", () => {
      const result = quoteAddLiquiditySchema.safeParse({
        ...validInput,
        resaleFloorBps: 9000,
      });
      expect(result.success).toBe(false);
    });

    it("validates token inputKind", () => {
      const result = quoteAddLiquiditySchema.safeParse({
        ...validInput,
        inputKind: "token",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid inputKind", () => {
      const result = quoteAddLiquiditySchema.safeParse({
        ...validInput,
        inputKind: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid amount format", () => {
      const result = quoteAddLiquiditySchema.safeParse({
        ...validInput,
        amount: "not-a-number",
      });
      expect(result.success).toBe(false);
    });

    it("accepts integer amount", () => {
      const result = quoteAddLiquiditySchema.safeParse({
        ...validInput,
        amount: "100",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("prepareTransactionSchema", () => {
    it("has same validation as quoteAddLiquiditySchema", () => {
      const validInput = {
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        inputMint: "So11111111111111111111111111111111111111112",
        inputKind: "native" as const,
        amount: "1.5",
      };
      const result = prepareTransactionSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });
  });

  describe("quoteCompoundSchema", () => {
    const validInput = {
      wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
      positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
    };

    it("validates correct input without sourceSignatures", () => {
      const result = quoteCompoundSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("validates with empty sourceSignatures", () => {
      const result = quoteCompoundSchema.safeParse({
        ...validInput,
        sourceSignatures: [],
      });
      expect(result.success).toBe(true);
    });

    it("validates with valid sourceSignatures", () => {
      const result = quoteCompoundSchema.safeParse({
        ...validInput,
        sourceSignatures: [
          "5J8H5sTvEhnGcB7vKKZHcZ8T1x8xqVvH6vM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5k",
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects too many sourceSignatures", () => {
      const result = quoteCompoundSchema.safeParse({
        ...validInput,
        sourceSignatures: [
          "5J8H5sTvEhnGcB7vKKZHcZ8T1x8xqVvH6vM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5k",
          "5J8H5sTvEhnGcB7vKKZHcZ8T1x8xqVvH6vM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5k",
          "5J8H5sTvEhnGcB7vKKZHcZ8T1x8xqVvH6vM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5k",
          "5J8H5sTvEhnGcB7vKKZHcZ8T1x8xqVvH6vM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5kH5jM8xVwE5k",
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid signature format", () => {
      const result = quoteCompoundSchema.safeParse({
        ...validInput,
        sourceSignatures: ["invalid"],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("submitSignedTransactionSchema", () => {
    const validInput = {
      signedTransaction: "base64encodedtransaction",
      permit: "permitstring",
      wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
      selection: {
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        inputMint: "So11111111111111111111111111111111111111112",
        inputKind: "native" as const,
      },
      requested: "1500000000",
      expectedLiquidity: "1000000",
      startingLiquidity: "900000",
      floorBps: 9900,
      expiresAt: Date.now() + 60000,
      lastValidBlockHeight: 1000000,
      rangeSide: "inside" as const,
      startingBalances: {
        input: "5000000000",
        a: "1000000",
        b: "2000000",
      },
    };

    it("validates correct input", () => {
      const result = submitSignedTransactionSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("rejects invalid rangeSide", () => {
      const result = submitSignedTransactionSchema.safeParse({
        ...validInput,
        rangeSide: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects floorBps not multiple of 10", () => {
      const result = submitSignedTransactionSchema.safeParse({
        ...validInput,
        floorBps: 9905,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer requested amount", () => {
      const result = submitSignedTransactionSchema.safeParse({
        ...validInput,
        requested: "1500.5",
      });
      expect(result.success).toBe(false);
    });

    it("rejects transaction too large", () => {
      const result = submitSignedTransactionSchema.safeParse({
        ...validInput,
        signedTransaction: "x".repeat(2501),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("submitCompoundTransactionSchema", () => {
    const validInput = {
      signedTransaction: "base64encodedtransaction",
      permit: "permitstring",
      wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
      summary: {
        operation: "compound",
        positionMint: "8BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM4",
        expiresAt: Date.now() + 60000,
      },
    };

    it("validates correct input", () => {
      const result = submitCompoundTransactionSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("rejects missing summary", () => {
      const result = submitCompoundTransactionSchema.safeParse({
        signedTransaction: "base64encodedtransaction",
        permit: "permitstring",
        wallet: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
      });
      expect(result.success).toBe(false);
    });
  });
});
