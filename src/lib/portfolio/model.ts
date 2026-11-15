import { z } from "zod";
import bs58 from "bs58";
import type { PortfolioTotals } from "./figures";

const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).refine((value) => {
  try { return bs58.decode(value).length === 32; } catch { return false; }
});
const signature = z.string().max(88).refine((value) => {
  try { return bs58.decode(value).length === 64; } catch { return false; }
});
export const MAX_PORTFOLIO_POSITIONS = 50;
export const portfolioRequestSchema = z.object({
  wallet: pubkey,
  positions: z.array(z.object({
    key: z.string().max(100).regex(/^[a-z0-9-]+:[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      .refine((key) => pubkey.safeParse(key.split(":")[1]).success),
    afterSignatures: z.array(signature).max(8).optional(),
  }).strict()).max(MAX_PORTFOLIO_POSITIONS),
  fresh: z.boolean().optional(),
}).strict();
export type PortfolioRequest = z.infer<typeof portfolioRequestSchema>;
const usd = z.number().finite().nullable();
export const portfolioPositionSchema = z.object({
  key: z.string(), status: z.enum(["ready", "partial", "failed"]),
  figures: z.object({ stock: z.string().nullable(), shares: usd, valueUsd: usd, unclaimedFeesUsd: usd, cumulativeFeesUsd: usd }),
  evaluatedAt: z.string().nullable(), historyComplete: z.boolean(), historyRefreshResolved: z.boolean(),
});
export type PortfolioPosition = z.infer<typeof portfolioPositionSchema>;
export type PortfolioResponse = {
  wallet: string;
  positions: PortfolioPosition[];
  totals: PortfolioTotals;
  timings: { totalMs: number; positions: Record<string, unknown> };
};

/** Prepared per-source reads share request-local inputs; only compact figures leave the source. */
export type PortfolioRead = Omit<PortfolioPosition, "key" | "status"> & { timings?: unknown };
export type PortfolioReader = (position: PortfolioRequest["positions"][number], signal: AbortSignal) => Promise<PortfolioRead>;
