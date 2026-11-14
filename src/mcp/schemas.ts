import "@/lib/engine-host";
import { z } from "zod";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";

// Solana public key validation (base58, 32-44 chars typically)
const publicKeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana public key");

/** Mint addresses for the two symbols the open tools name in their description. */
const INPUT_MINT_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  SOL: NATIVE_SOL_MINT,
  USDC: USDC_MINT,
});

/** A mint address, or "SOL" / "USDC" (any case), resolved to its mint before validation. */
const inputMintSchema = z.string().transform((value) => {
  const trimmed = value.trim();
  return INPUT_MINT_SYMBOLS[trimmed.toUpperCase()] ?? trimmed;
}).pipe(publicKeySchema);

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
  unsignedTransaction: z.string().max(2500, "Unsigned transaction too large").optional(),
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
  unsignedTransaction: z.string().max(2500, "Unsigned transaction too large").optional(),
  permit: z.string(),
  wallet: publicKeySchema,
  summary: z.any(), // Complex object, validated by existing code
});
export type SubmitCompoundTransactionInput = z.infer<typeof submitCompoundTransactionSchema>;

// List RWA same-asset CLMM pairs (read-only discovery)
export const listRwaPairsSchema = z.object({
  minTvl: z.number().min(0).default(0),
  /** Accepted for older clients; the list now comes from the saved pools snapshot, so it has no effect. */
  maxPages: z.number().int().min(1).max(30).default(3),
  sortBy: z.enum(["apr7d", "estimatedFeeApr", "tvl", "volume24h"]).default("apr7d"),
  /** Ticker filter, e.g. "TSLA": matches either token symbol or the pair's base ticker (case-insensitive). */
  symbol: z.string().trim().min(1).max(16).optional(),
});
export type ListRwaPairsInput = z.infer<typeof listRwaPairsSchema>;

// 7-day range APR for one listed pool, from the saved snapshot (read-only)
export const getPoolRangeAprSchema = z.object({
  poolId: publicKeySchema,
});
export type GetPoolRangeAprInput = z.infer<typeof getPoolRangeAprSchema>;

const openRangePresetSchema = z.enum(["tight", "standard", "wide", "custom"]).default("standard");

export const quoteOpenPositionSchema = z.object({
  wallet: publicKeySchema,
  poolId: publicKeySchema,
  inputMint: inputMintSchema,
  inputKind: z.enum(["native", "token"]),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "Amount must be a valid decimal number"),
  rangePreset: openRangePresetSchema,
  minPrice: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  maxPrice: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  resaleFloorBps: z.number().int().min(9500).max(10000).multipleOf(10).default(9900),
  slippageToleranceBps: z.number().int().min(0).max(500).multipleOf(10).default(100),
});
export type QuoteOpenPositionInput = z.infer<typeof quoteOpenPositionSchema>;
export const prepareOpenPositionSchema = quoteOpenPositionSchema.extend({
  nftMint: publicKeySchema.optional().describe("Client-generated position NFT mint. Prefer this: wallet signs first, then the agent adds the mint signature. If omitted, open signUrl: the sign page generates the mint in the browser and the wallet still signs first."),
});
export type PrepareOpenPositionInput = z.infer<typeof prepareOpenPositionSchema>;

export const submitOpenPositionSchema = z.object({
  signedTransaction: z.string().max(2500, "Signed transaction too large"),
  unsignedTransaction: z.string().max(2500, "Unsigned transaction too large").optional(),
  permit: z.string(),
  wallet: publicKeySchema,
  summary: z.any(),
});
export type SubmitOpenPositionInput = z.infer<typeof submitOpenPositionSchema>;


// Position holding-period / realized fee APR (read-only)
export const getPositionPerformanceSchema = z.object({
  positionMint: publicKeySchema,
  wallet: publicKeySchema.optional(),
  maxSignatures: z.number().int().min(1).max(500).default(100),
  refreshHistory: z.boolean().optional().describe("Force a fresh history read after a transaction"),
  historyAfterSignatures: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)).max(8).optional(),
  skipPricing: z.boolean().default(false),
});
export type GetPositionPerformanceInput = z.infer<typeof getPositionPerformanceSchema>;

export const getPositionRangeStatusSchema = z.object({
  positionMint: publicKeySchema,
  wallet: publicKeySchema.optional(),
  poolId: publicKeySchema.optional(),
});
export type GetPositionRangeStatusInput = z.infer<typeof getPositionRangeStatusSchema>;

export { withdrawPrepareSchema as prepareWithdrawSchema, withdrawSubmitSchema as submitWithdrawSchema } from "@sofinance/engine/withdraw/input";
