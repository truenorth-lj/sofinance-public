import { z } from "zod";

const address = z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const signature = z.string().trim().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const binId = z.number().int().min(-443636).max(443636);
const open = {
  wallet: address, poolId: address, inputMint: address, position: address,
  amount: z.string().regex(/^[1-9]\d{0,19}$/), lowerBinId: binId, upperBinId: binId,
};

/** `/api/meteora-open` body. `setup` (1/2), `deposit` (2/2), `close` (refund) build + simulate; `record` logs a landed open. */
export const MeteoraOpenRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup"), ...open }),
  z.object({ action: z.literal("deposit"), ...open }),
  z.object({ action: z.literal("close"), wallet: address, poolId: address, position: address }),
  z.object({ action: z.literal("record"), wallet: address, setupSignature: signature, depositSignature: signature, sourceRef: z.string().max(64).optional() }),
]);
export type MeteoraOpenRequest = z.infer<typeof MeteoraOpenRequestSchema>;
