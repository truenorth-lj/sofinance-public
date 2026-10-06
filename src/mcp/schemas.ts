import { z } from "zod";

// Solana public key validation (base58, 32-44 chars typically)
const publicKeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana public key");

// List positions input schema
export const listPositionsSchema = z.object({
  wallet: publicKeySchema,
});
export type ListPositionsInput = z.infer<typeof listPositionsSchema>;

// Quote add liquidity input schema
export const quoteAddLiquiditySchema = z.object({
  wallet: publicKeySchema,
  positionMint: publicKeySchema,
  inputMint: publicKeySchema,
  inputKind: z.enum(["native", "token"]),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "Amount must be a valid decimal number"),
  resaleFloorBps: z.number().int().min(9500).max(10000).multipleOf(10).default(9900),
  slippageToleranceBps: z.number().int().min(0).max(500).multipleOf(10).default(100),
});
export type QuoteAddLiquidityInput = z.infer<typeof quoteAddLiquiditySchema>;

// Prepare transaction input schema
export const prepareTransactionSchema = z.object({
  wallet: publicKeySchema,
  positionMint: publicKeySchema,
  inputMint: publicKeySchema,
  inputKind: z.enum(["native", "token"]),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "Amount must be a valid decimal number"),
  resaleFloorBps: z.number().int().min(9500).max(10000).multipleOf(10).default(9900),
  slippageToleranceBps: z.number().int().min(0).max(500).multipleOf(10).default(100),
});
export type PrepareTransactionInput = z.infer<typeof prepareTransactionSchema>;

// Quote compound input schema
export const quoteCompoundSchema = z.object({
  wallet: publicKeySchema,
  positionMint: publicKeySchema,
  sourceSignatures: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/)).max(3).optional(),
});
export type QuoteCompoundInput = z.infer<typeof quoteCompoundSchema>;

// Submit signed transaction input schema
export const submitSignedTransactionSchema = z.object({
  signedTransaction: z.string().max(2500, "Signed transaction too large"),
  permit: z.string(),
  wallet: publicKeySchema,
  selection: z.object({
    positionMint: publicKeySchema,
    inputMint: publicKeySchema,
    inputKind: z.enum(["native", "token"]),
  }),
  requested: z.string().regex(/^\d+$/, "Requested must be a valid integer"),
  expectedLiquidity: z.string().regex(/^\d+$/, "Expected liquidity must be a valid integer"),
  startingLiquidity: z.string().regex(/^\d+$/, "Starting liquidity must be a valid integer"),
  floorBps: z.number().int().min(9500).max(10000).multipleOf(10),
  expiresAt: z.number().int().positive(),
  lastValidBlockHeight: z.number().int().positive(),
  rangeSide: z.enum(["below", "inside", "above"]),
  startingBalances: z.object({
    input: z.string().regex(/^\d+$/),
    a: z.string().regex(/^\d+$/),
    b: z.string().regex(/^\d+$/),
  }),
});
export type SubmitSignedTransactionInput = z.infer<typeof submitSignedTransactionSchema>;

// Submit compound transaction input schema
export const submitCompoundTransactionSchema = z.object({
  signedTransaction: z.string().max(2500, "Signed transaction too large"),
  permit: z.string(),
  wallet: publicKeySchema,
  summary: z.any(), // Complex object, validated by existing code
});
export type SubmitCompoundTransactionInput = z.infer<typeof submitCompoundTransactionSchema>;

// List RWA same-asset CLMM pairs (read-only discovery)
export const listRwaPairsSchema = z.object({
  minTvl: z.number().min(0).default(0),
  maxPages: z.number().int().min(1).max(30).default(10),
  sortBy: z.enum(["estimatedFeeApr", "tvl", "volume24h"]).default("estimatedFeeApr"),
});
export type ListRwaPairsInput = z.infer<typeof listRwaPairsSchema>;
