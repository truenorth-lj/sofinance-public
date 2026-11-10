import "server-only";
/**
 * One deposit's entry price from the reference pool's trades just before it. RPC budget per deposit: one
 * `getSignaturesForAddress(pool, { before: deposit, limit: 12 })` plus at most 12 `getTransaction`, read newest first in
 * groups of 4 and stopped once 3 usable trades are in hand; signatures older than the hour window are never read.
 * Callers pass a history-transport connection (`createHistoryRpcConnections`) so the calls share history pacing.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  ENTRY_PRICE_MAX_AGE_SECONDS, ENTRY_PRICE_TRADES, entryPriceFromTrades, tradeFromTransaction,
  type EntryPriceResult, type PoolTrade, type RawPoolTransaction,
} from "./stock-entry-price-trades";
import type { StockReferencePool } from "./stock-reference-pools";

export const ENTRY_PRICE_SIGNATURE_PAGE = 12;
const TRANSACTION_GROUP = 4;
/** "Transaction version (n) is not supported by the requesting client": skip that one transaction. */
const UNSUPPORTED_TRANSACTION_VERSION = -32015;

export type PoolSignature = { signature: string; blockTime?: number | null; err: unknown };
export type EntryPriceRpc = {
  signaturesBefore(pool: string, before: string, limit: number): Promise<readonly PoolSignature[]>;
  /** Null when there is no readable copy (not found, or a transaction version newer than v1). Throws on transport failure. */
  transaction(signature: string): Promise<RawPoolTransaction | null>;
};
type RawRpcResponse = { result?: unknown; error?: { code?: number; message?: string } };
/** web3.js's raw request: the engine connection routes it through the provider pool and the history transport. */
type RawRpcConnection = Connection & { _rpcRequest(method: string, params: unknown[]): Promise<RawRpcResponse> };

export function entryPriceRpc(connection: Connection): EntryPriceRpc {
  return {
    signaturesBefore: (pool, before, limit) =>
      connection.getSignaturesForAddress(new PublicKey(pool), { before, limit }, "confirmed"),
    async transaction(signature) {
      // Most swaps are now v1 transactions, which web3.js's parsed-transaction schema rejects: read the raw result.
      const response = await (connection as RawRpcConnection)._rpcRequest("getTransaction",
        [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
      if (response.error) {
        if (response.error.code === UNSUPPORTED_TRANSACTION_VERSION) return null;
        throw new Error(`getTransaction failed (${response.error.code ?? "unknown"})`);
      }
      return (response.result ?? null) as RawPoolTransaction | null;
    },
  };
}

export type EntryPriceLookup = EntryPriceResult & { rpcCalls: number };

/** Throws on RPC failure; the caller stores only definite results, so a failure is retried on a later view. */
export async function lookupDepositEntryPrice(rpc: EntryPriceRpc, ref: StockReferencePool,
  deposit: { signature: string; blockTime: number }, signal?: AbortSignal): Promise<EntryPriceLookup> {
  signal?.throwIfAborted();
  const page = await rpc.signaturesBefore(ref.pool, deposit.signature, ENTRY_PRICE_SIGNATURE_PAGE);
  let rpcCalls = 1;
  const candidates = page.slice(0, ENTRY_PRICE_SIGNATURE_PAGE).filter((item) => !item.err && typeof item.blockTime === "number" &&
    item.blockTime <= deposit.blockTime && deposit.blockTime - item.blockTime <= ENTRY_PRICE_MAX_AGE_SECONDS);
  const trades: PoolTrade[] = [];
  for (let start = 0; start < candidates.length && trades.length < ENTRY_PRICE_TRADES; start += TRANSACTION_GROUP) {
    signal?.throwIfAborted();
    const group = candidates.slice(start, start + TRANSACTION_GROUP);
    rpcCalls += group.length;
    const transactions = await Promise.all(group.map((item) => rpc.transaction(item.signature)));
    group.forEach((item, index) => {
      const trade = tradeFromTransaction(item.signature, transactions[index] ?? null, ref);
      if (trade) trades.push(trade);
    });
  }
  return { ...entryPriceFromTrades(trades, deposit.blockTime), rpcCalls };
}
