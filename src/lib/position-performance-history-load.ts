import type { Connection } from "@solana/web3.js";
import type { PositionEventContext } from "./position-performance-events";
import { parsePositionCashflowEvents } from "./position-performance-events";
import { fetchPositionHistoryTransactions, toChronological, type FetchPositionHistoryOptions,
  type HistoryConnection } from "./position-performance-history";
import type { PositionHistoryStore } from "./position-history-store-types";
import { syncPositionHistory, type SyncedPositionHistory } from "./position-history-sync";
import { cachedSyncPositionHistory } from "./position-history-cache";

/** Durable and legacy readers produce the same event ledger for valuation. */
export async function loadPerformanceHistory(options: FetchPositionHistoryOptions & {
  context: PositionEventContext; store?: PositionHistoryStore | null; signal?: AbortSignal;
  bypassCache?: boolean; stateFingerprint?: string; afterSignatures?: string[];
  connectionsForSignal?: (signal: AbortSignal) => { connection: HistoryConnection; fallbackConnection?: HistoryConnection };
}) {
  const checkRefresh = async (result: SyncedPositionHistory, historyConnection: HistoryConnection) => {
    if (options.afterSignatures?.length) {
      const included = new Set(result.history.map(row => row.signature));
      const missing = options.afterSignatures.filter(signature => !included.has(signature));
      let resolved = missing.length === 0;
      const connection = historyConnection as HistoryConnection & { getSignatureStatuses?: Connection["getSignatureStatuses"] };
      if (missing.length && connection.getSignatureStatuses) {
        const observed = await connection.getSignatureStatuses(missing, { searchTransactionHistory: true });
        resolved = missing.every((_, index) => observed.value[index]?.confirmationStatus === "finalized" && Boolean(observed.value[index]?.err));
      }
      result.metric.refreshSignaturesResolved = resolved;
      if (!resolved) {
        result.truncated = true;
        result.metric.historyComplete = false;
        result.metric.canContinue = false;
      }
    }
    return result;
  };
  if (options.store) return cachedSyncPositionHistory({
    context: options.context, store: options.store, connection: options.connection,
    fallbackConnection: options.fallbackConnection, provider: options.provider,
    maxSignatures: options.maxSignatures, signal: options.signal,
    bypassCache: options.bypassCache || Boolean(options.afterSignatures?.length), stateFingerprint: options.stateFingerprint,
  }, async (syncOptions) => {
    // Shared history work must not inherit the first viewer's cancellation.
    const connections = options.connectionsForSignal?.(syncOptions.signal!) ?? {
      connection: syncOptions.connection, fallbackConnection: syncOptions.fallbackConnection };
    return checkRefresh(await syncPositionHistory({ ...syncOptions, ...connections }), connections.connection);
  });
  const fetched = await fetchPositionHistoryTransactions(options);
  const history = toChronological(fetched.items).flatMap((info) => {
    if (info.err) return [];
    const events = parsePositionCashflowEvents(info.logMessages, info.parsedTransaction, options.context)
      .filter((event) => event.kind === "open" ? event.poolState === options.context.poolId
        : event.positionNftMint === options.context.positionMint);
    return events.length ? [{ signature: info.signature, blockTime: info.blockTime, slot: info.slot, events }] : [];
  });
  return checkRefresh({ history, signatureCount: fetched.signatureCount, truncated: fetched.truncated, metric: fetched.metric }, options.connection);
}
