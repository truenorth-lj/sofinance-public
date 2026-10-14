import type { PositionEventContext } from "./position-performance-events";
import { parsePositionCashflowEvents } from "./position-performance-events";
import { fetchPositionHistoryTransactions, toChronological, type FetchPositionHistoryOptions } from "./position-performance-history";
import type { PositionHistoryStore } from "./position-history-store-types";
import { syncPositionHistory } from "./position-history-sync";

/** Durable and legacy readers produce the same event ledger for valuation. */
export async function loadPerformanceHistory(options: FetchPositionHistoryOptions & {
  context: PositionEventContext; store?: PositionHistoryStore | null; signal?: AbortSignal;
}) {
  if (options.store) return syncPositionHistory({
    context: options.context, store: options.store, connection: options.connection,
    fallbackConnection: options.fallbackConnection, provider: options.provider,
    maxSignatures: options.maxSignatures, signal: options.signal,
  });
  const fetched = await fetchPositionHistoryTransactions(options);
  const history = toChronological(fetched.items).flatMap((info) => {
    if (info.err) return [];
    const events = parsePositionCashflowEvents(info.logMessages, info.parsedTransaction, options.context)
      .filter((event) => event.kind === "open" ? event.poolState === options.context.poolId
        : event.positionNftMint === options.context.positionMint);
    return events.length ? [{ signature: info.signature, blockTime: info.blockTime, slot: info.slot, events }] : [];
  });
  return { history, signatureCount: fetched.signatureCount, truncated: fetched.truncated, metric: fetched.metric };
}
