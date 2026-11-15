import "server-only";
import { POSITION_HISTORY_PARSER_VERSION, type PositionContext, type PositionHistoryStore } from "@/lib/position-history-store-types";
import type { SyncedPositionHistory } from "@/lib/position-history-sync";
import type { PortfolioPosition } from "./model";

export const PORTFOLIO_HISTORY_TTL_MS = 30_000;
type SnapshotResult = Pick<PortfolioPosition, "historyUpdatedAt" | "historyStatus" | "historyRefreshAfter" | "historyRefreshResolved"> & {
  history: SyncedPositionHistory;
  needsSync: boolean;
};

/** No history RPC or lease acquisition is allowed on this path. */
export async function readPortfolioHistory(options: {
  store: PositionHistoryStore; context: PositionContext; fresh?: boolean;
  refreshAfter?: string; afterSignatures?: string[];
}): Promise<SnapshotResult> {
  const started = Date.now();
  const snapshot = await options.store.request({ op: "read", context: options.context, parserVersion: POSITION_HISTORY_PARSER_VERSION });
  const rows = snapshot?.transactions ?? [];
  const current = rows.filter((row) => row.status === "parsed" && row.parserVersion === POSITION_HISTORY_PARSER_VERSION);
  const history = current.filter((row) => row.events.length).map(({ signature, slot, blockTime, events }) => ({ signature, slot, blockTime, events }))
    .sort((a, b) => a.slot - b.slot || (a.blockTime ?? 0) - (b.blockTime ?? 0));
  const complete = Boolean(snapshot?.state.complete && snapshot.state.parserVersion === POSITION_HISTORY_PARSER_VERSION
    && !snapshot.state.deltaBefore && !snapshot.state.deltaHead
    && history.some((row) => row.events.some((event) => event.kind === "open"))
    && !rows.some((row) => row.status !== "ignored" && (row.status === "pending" || row.parserVersion !== POSITION_HISTORY_PARSER_VERSION)));
  // Only finalized failed signatures or included cashflow events acknowledge a transaction.
  const observed = new Set([...history.map((row) => row.signature), ...rows.filter((row) => row.status === "failed").map((row) => row.signature)]);
  const signaturesResolved = (options.afterSignatures ?? []).every((signature) => observed.has(signature));
  const refreshAfter = options.refreshAfter ?? (options.fresh ? snapshot?.readAt ?? new Date(started).toISOString() : undefined);
  const checked = snapshot ? Date.parse(snapshot.updatedAt) : NaN;
  const readAt = snapshot ? Date.parse(snapshot.readAt) : started;
  const age = readAt - checked;
  const fresh = complete && signaturesResolved && Number.isFinite(age) && age >= 0 && age < PORTFOLIO_HISTORY_TTL_MS
    && (!refreshAfter || checked >= Date.parse(refreshAfter));
  return {
    history: { history, signatureCount: rows.length, truncated: !complete, metric: {
      txCount: current.length, elapsedMs: Date.now() - started, provider: "default", source: "databaseSnapshot",
      defaultTxCount: 0, fallbackReasons: [], cachedTxCount: rows.length, fetchedTxCount: 0, listingCount: 0,
      historyComplete: complete, historySyncedAt: snapshot?.updatedAt,
      refreshSignaturesResolved: signaturesResolved && fresh,
    } },
    historyUpdatedAt: complete && Number.isFinite(checked) ? new Date(checked).toISOString() : null,
    historyStatus: fresh && !snapshot?.syncing ? "fresh" : "updating",
    historyRefreshAfter: refreshAfter,
    historyRefreshResolved: fresh && signaturesResolved,
    needsSync: !fresh && !snapshot?.syncing,
  };
}
