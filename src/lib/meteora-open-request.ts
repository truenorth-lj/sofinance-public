import { z } from "zod";

const address = z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const signature = z.string().trim().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const binId = z.number().int().min(-443636).max(443636);
const open = {
  wallet: address, poolId: address, inputMint: address, position: address,
  amount: z.string().regex(/^[1-9]\d{0,19}$/), lowerBinId: binId, upperBinId: binId,
};

/**
 * `/api/meteora-open` body. `setup` (1/2), `deposit` (2/2), `close` (refund) build + simulate; `balances` reads the wallet;
 * `send` broadcasts a wallet-signed prepared tx, `status` polls it, `record` logs a landed open (signing flag).
 */
export const MeteoraOpenRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup"), ...open }),
  z.object({ action: z.literal("deposit"), ...open }),
  z.object({ action: z.literal("close"), wallet: address, poolId: address, position: address }),
  z.object({ action: z.literal("balances"), wallet: address }),
  z.object({
    action: z.literal("send"),
    signedTransaction: z.string().min(1).max(4096),
    unsignedTransaction: z.string().min(1).max(4096),
    permit: z.string().regex(/^[0-9a-f]{64}$/),
    summary: z.object({
      kind: z.enum(["setup", "deposit", "close"]), wallet: address, poolId: address, position: address, blockhash: address,
      lastValidBlockHeight: z.number().int().positive(), expiresAt: z.number().int().positive(), maxSolDebitLamports: z.string().regex(/^\d{1,20}$/),
    }).strict(),
  }),
  z.object({ action: z.literal("status"), signature, lastValidBlockHeight: z.number().int().positive() }),
  z.object({ action: z.literal("record"), wallet: address, setupSignature: signature, depositSignature: signature, sourceRef: z.string().max(64).optional() }),
]);
export type MeteoraOpenRequest = z.infer<typeof MeteoraOpenRequestSchema>;
