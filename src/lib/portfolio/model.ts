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
/**
 * Follow-up delays (ms) while fee history is "updating", measured from the previous response. A background sync after the
 * first read usually lands in about 3 s, so the first follow-up comes at 4 s; slower syncs (cold instance, paced history
 * RPC, a 12 s job deadline) are caught by the backed-off later rounds. Total 45 s, inside the 55 s background deadline of
 * `/api/portfolio`. One page load is at most 1 + PORTFOLIO_POLL_DELAYS_MS.length requests per batch of positions.
 */
export const PORTFOLIO_POLL_DELAYS_MS = [4_000, 6_000, 9_000, 12_000, 14_000] as const;
export const portfolioRequestSchema = z.object({
  wallet: pubkey,
  positions: z.array(z.object({
    key: z.string().max(100).regex(/^[a-z0-9-]+:[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      .refine((key) => pubkey.safeParse(key.split(":")[1]).success),
    afterSignatures: z.array(signature).max(8).optional(),
    refreshAfter: z.iso.datetime().optional(),
  }).strict()).max(MAX_PORTFOLIO_POSITIONS),
  fresh: z.boolean().optional(),
}).strict();
export type PortfolioRequest = z.infer<typeof portfolioRequestSchema>;
const usd = z.number().finite().nullable();
const rawAmount = z.string().regex(/^\d{1,40}$/);
export const portfolioPositionSchema = z.object({
  key: z.string(), status: z.enum(["ready", "partial", "failed"]),
  figures: z.object({ stock: z.string().nullable(), shares: usd, valueUsd: usd, unclaimedFeesUsd: usd, cumulativeFeesUsd: usd }),
  /** Raw unclaimed fees (token units) from the same on-chain read as `unclaimedFeesUsd`; kept when a price is missing. */
  unclaimedFeesRaw: z.object({ a: rawAmount, b: rawAmount }).strict().optional(),
  evaluatedAt: z.string().nullable(), historyComplete: z.boolean(), historyRefreshResolved: z.boolean(),
  historyUpdatedAt: z.iso.datetime().nullable().optional(),
  historyStatus: z.enum(["fresh", "updating", "stale", "unavailable"]).optional(),
  historyRefreshAfter: z.iso.datetime().optional(),
  /** Position-history store failure code (for example POSITION_STORE_UNAVAILABLE). Value and unclaimed fees are still read; cumulative fees are not. */
  historyError: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  /** Client-only: a last complete cumulative fee was kept while history is catching up. */
  retained: z.boolean().optional(),
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
export type PortfolioHistoryScheduler = (key: string, work: (signal: AbortSignal) => Promise<void>) => void;
export type PortfolioInput = PortfolioRequest & { scheduleHistoryRefresh?: PortfolioHistoryScheduler };
