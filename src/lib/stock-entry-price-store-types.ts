import { z } from "zod";

/** Bump when the lookup method changes: rows with another version are ignored on read and replaced on write. */
export const STOCK_ENTRY_PRICE_METHOD_VERSION = 1;
export const MAX_ENTRY_PRICE_READ = 200;
export const MAX_ENTRY_PRICE_WRITE = 20;

const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usd = z.number().positive().finite();
const tradeSchema = z.object({ signature, blockTime: safeInteger, priceUsd: usd, usdcSize: usd });
const rowBase = { depositSignature: signature, priceMint: pubkey, depositSlot: safeInteger, depositBlockTime: safeInteger,
  referencePool: pubkey, methodVersion: z.number().int().positive() };
export const entryPriceRowSchema = z.discriminatedUnion("status", [
  z.object({ ...rowBase, status: z.literal("ok"), priceUsd: usd, trades: z.array(tradeSchema).min(1).max(3) }),
  z.object({ ...rowBase, status: z.literal("no_trade"), priceUsd: z.null(), trades: z.array(tradeSchema).max(0) }),
]);
export type StockEntryPriceRow = z.infer<typeof entryPriceRowSchema>;

export const entryPriceStoreRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read"), priceMint: pubkey, methodVersion: z.number().int().positive(),
    signatures: z.array(signature).min(1).max(MAX_ENTRY_PRICE_READ) }),
  z.object({ op: z.literal("write"), rows: z.array(entryPriceRowSchema).min(1).max(MAX_ENTRY_PRICE_WRITE) }),
]);
type ParsedEntryPriceRequest = z.infer<typeof entryPriceStoreRequestSchema>;
export type EntryPriceStoreOperation = ParsedEntryPriceRequest["op"];
export type EntryPriceStoreRequest<K extends EntryPriceStoreOperation = EntryPriceStoreOperation> = {
  [P in K]: Extract<ParsedEntryPriceRequest, { op: P }>;
}[K];
export type EntryPriceStoreResultMap = {
  read: StockEntryPriceRow[];
  /** Rows inserted or replaced (an existing row of the same method version is kept). */
  write: number;
};
export interface StockEntryPriceStore {
  request<K extends EntryPriceStoreOperation>(input: EntryPriceStoreRequest<K>): Promise<EntryPriceStoreResultMap[K]>;
}
export class StockEntryPriceStoreError extends Error {
  constructor(public readonly code: string) { super(code); }
}
