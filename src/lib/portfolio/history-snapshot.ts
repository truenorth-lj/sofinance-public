import "server-only";
import { POSITION_HISTORY_PARSER_VERSION, type PositionContext, type PositionHistoryStore } from "@/lib/position-history-store-types";
import type { SyncedPositionHistory } from "@/lib/position-history-sync";
import type { PortfolioPosition } from "./model";

/**
 * How long a complete stored ledger counts as fresh without a new sync. Cumulative fees = stored collects + live on-chain
 * uncollected fees, so only a collect made outside this app can make the stored part lag, and only until this window
 * ends. Transactions made in this app send their signatures (`afterSignatures`) and Refresh sends a barrier
 * (`refreshAfter`); both still force a sync inside the window. Was 30 s, which made nearly every page load "updating".
 */
export const PORTFOLIO_HISTORY_TTL_MS = 5 * 60_000;
export type PortfolioHistoryResult = Pick<PortfolioPosition, "historyUpdatedAt" | "historyStatus" | "historyRefreshAfter" | "historyRefreshResolved"> & {
  history: SyncedPositionHistory;
  needsSync: boolean;
};
type SnapshotResult = PortfolioHistoryResult;

/**
 * The position-history store could not be read. Valuation does not need it: value and unclaimed fees come from the
 * position's on-chain accounts and prices. This is an empty, incomplete ledger (so cumulative fees stay unknown),
 * with the store's error code carried through. It schedules no sync and makes no RPC call.
 */
export function unavailablePortfolioHistory(code: string, elapsedMs = 0): PortfolioHistoryResult & { historyError: string } {
  return {
    history: { history: [], signatureCount: 0, truncated: true, metric: {
      txCount: 0, elapsedMs, provider: "default", source: "databaseSnapshot", defaultTxCount: 0, fallbackReasons: [],
      cachedTxCount: 0, fetchedTxCount: 0, listingCount: 0, historyComplete: false,
    } },
    historyUpdatedAt: null, historyStatus: "unavailable", historyRefreshResolved: false, needsSync: false, historyError: code,
  };
}

/** No history RPC or lease acquisition is allowed on this path. */
export async function readPortfolioHistory(options: {
  store: PositionHistoryStore; context: PositionContext; fresh?: boolean;
  refreshAfter?: string; afterSignatures?: string[];
}): Promise<SnapshotResult> {
  const started = Date.now();
  const { snapshot, readAt: observedAt } = await options.store.request({ op: "read", context: options.context, parserVersion: POSITION_HISTORY_PARSER_VERSION });
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
  const refreshAfter = options.refreshAfter ?? (options.fresh ? observedAt : undefined);
  const checked = snapshot ? Date.parse(snapshot.updatedAt) : NaN;
  const readAt = Date.parse(observedAt);
  const age = readAt - checked;
  const fresh = complete && signaturesResolved && Number.isFinite(age) && age >= 0 && age < PORTFOLIO_HISTORY_TTL_MS
    && (!refreshAfter || checked >= Date.parse(refreshAfter));
  return {
    history: { history, signatureCount: rows.length, truncated: !complete, metric: {
      txCount: current.length, elapsedMs: Date.now() - started, provider: "default", source: "databaseSnapshot",
      defaultTxCount: 0, fallbackReasons: [], cachedTxCount: rows.length, fetchedTxCount: 0, listingCount: 0,
      historyComplete: complete, historySyncedAt: snapshot?.updatedAt,
      // Valuation uses this metric to withhold fees for missing transactions.
      // Age/Refresh barriers belong to DTO freshness, not ledger completeness.
      ...(options.afterSignatures?.length ? { refreshSignaturesResolved: signaturesResolved } : {}),
    } },
    historyUpdatedAt: complete && Number.isFinite(checked) && checked > 0 ? new Date(checked).toISOString() : null,
    historyStatus: fresh && !snapshot?.syncing ? "fresh" : "updating",
    historyRefreshAfter: refreshAfter,
    historyRefreshResolved: fresh && signaturesResolved,
    needsSync: !fresh && !snapshot?.syncing,
  };
}
