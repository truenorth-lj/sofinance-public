import { z } from "zod";
import { parseWallet } from "../api-input";
const address = z.string().transform(value => parseWallet(value));
export const withdrawRequestSchema = z.object({
    wallet: address, positionMint: address, percent: z.number().min(1).max(100).optional(),
    targetUSDC: z.number().positive().optional(), receive: z.enum(["usdc", "token", "original"]).default("usdc"),
    outputMint: address.optional(), confirmHighImpact: z.boolean().optional(),
}).refine(v => (v.percent === undefined) !== (v.targetUSDC === undefined), "Provide percent or target USDC");
export const withdrawPrepareSchema = withdrawRequestSchema.safeExtend({
    stage: z.literal("swap").optional(), tx1Signature: z.string().optional(),
    previous: z.custom<import("./types").WithdrawPrepared>(value => typeof value === "object" && value !== null).optional(),
});
export const withdrawSubmitSchema = z.object({ wallet: address, signedTransaction: z.string().max(2500),
    unsignedTransaction: z.string().max(2500).optional(), permit: z.string(),
    summary: z.record(z.string(), z.unknown()), confirmHighImpact: z.boolean().optional() });
