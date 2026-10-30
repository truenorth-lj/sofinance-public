import { z } from "zod";
import type { PositionCashflowEvent, PositionEventContext } from "./position-performance-events";

export const POSITION_HISTORY_PARSER_VERSION = 1;
export const POSITION_HISTORY_LEASE_MS = 120_000;
export const MAX_POSITION_HISTORY_TRANSACTIONS = 10_000;
const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
const integerAmount = z.string().regex(/^\d{1,78}$/);
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), poolState: pubkey, nftOwner: pubkey,
    tickLower: z.number().int(), tickUpper: z.number().int(), liquidity: integerAmount,
    amountA: integerAmount, amountB: integerAmount }),
  z.object({ kind: z.literal("increase"), positionNftMint: pubkey, liquidity: integerAmount,
    amountA: integerAmount, amountB: integerAmount }),
  z.object({ kind: z.literal("decrease"), positionNftMint: pubkey, liquidity: integerAmount,
    principalA: integerAmount, principalB: integerAmount, feeA: integerAmount, feeB: integerAmount }),
]);
export const positionContextSchema = z.object({ positionMint: pubkey, positionAccount: pubkey,
  poolId: pubkey, mintA: pubkey, mintB: pubkey, vaultA: pubkey, vaultB: pubkey });
export type StoredPositionTransaction = {
  signature: string; slot: number; blockTime: number | null;
  status: "parsed" | "pending" | "failed" | "ignored";
  receipt: Record<string, unknown> | null;
  events: PositionCashflowEvent[]; parserVersion: number;
};
export type PositionHistoryState = {
  headSignature: string | null; backfillBefore: string | null;
  deltaBefore?: string | null; deltaHead?: string | null;
  complete: boolean; revision: number; parserVersion: number;
};
export const positionLeaseSchema = z.object({ positionMint: pubkey, owner: z.uuid(),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export type PositionHistoryLease = z.infer<typeof positionLeaseSchema>;
export type PositionHistorySnapshot = {
  lease: PositionHistoryLease | null; state: PositionHistoryState;
  transactions: StoredPositionTransaction[];
};
const transactionSchema = z.object({ signature, slot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  blockTime: z.number().int().nonnegative().nullable(), status: z.enum(["parsed", "pending", "failed", "ignored"]),
  receipt: z.record(z.string(), z.unknown()).nullable(), events: z.array(eventSchema).max(100),
  parserVersion: z.number().int().positive() }).refine((row) => row.status !== "ignored" || row.events.length === 0, { message: "Ignored transactions cannot contain events" });
export const positionStoreRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("claim"), context: positionContextSchema, parserVersion: z.number().int().positive() }),
  z.object({ op: z.literal("commit"), lease: positionLeaseSchema,
    state: z.object({ headSignature: signature.nullable(), backfillBefore: signature.nullable(),
      deltaBefore: signature.nullable().optional(), deltaHead: signature.nullable().optional(),
      complete: z.boolean(), parserVersion: z.number().int().positive() }),
    transactions: z.array(transactionSchema).max(500) }),
  z.object({ op: z.literal("release"), lease: positionLeaseSchema }),
]);
type ParsedPositionStoreRequest = z.infer<typeof positionStoreRequestSchema>;
export type PositionStoreOperation = ParsedPositionStoreRequest["op"];
export type PositionStoreRequest<K extends PositionStoreOperation = PositionStoreOperation> = {
  [P in K]: Extract<ParsedPositionStoreRequest, { op: P }>;
}[K];
export type PositionStoreResultMap = {
  claim: PositionHistorySnapshot;
  commit: PositionHistorySnapshot;
  release: boolean;
};
export type PositionStoreHandlers = {
  [K in PositionStoreOperation]: (input: PositionStoreRequest<K>) => Promise<PositionStoreResultMap[K]>;
};
export interface PositionHistoryStore {
  request<K extends PositionStoreOperation>(input: PositionStoreRequest<K>): Promise<PositionStoreResultMap[K]>;
}
export class PositionHistoryStoreError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export type PositionContext = PositionEventContext;
