import "@/lib/engine-host";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { parsePositionCashflowEvents, type PositionCashflowEvent, type PositionEventContext } from "./position-performance-events";
import { type HistoryConnection, type HistoryFetchMetric, type HistoryFallbackReason,
  type HistorySignature } from "./position-performance-history";
import { mapPositionHistoryWorkers } from "./position-history-workers";
import { MAX_POSITION_HISTORY_TRANSACTIONS, POSITION_HISTORY_PARSER_VERSION, type PositionHistorySnapshot, type PositionHistoryStore,
  type StoredPositionTransaction } from "./position-history-store-types";
import type { RpcProvider } from "@sofinance/engine/rpc/types";

export type SyncPositionHistoryOptions = {
  context: PositionEventContext; store: PositionHistoryStore; connection: HistoryConnection;
  fallbackConnection?: HistoryConnection; maxSignatures: number; signal?: AbortSignal;
  provider?: RpcProvider;
  /** Paced transports bound foreground detail work independently of the API history limit. */
  maxDetailRequests?: number;
  receiptProvider?: (signature: string) => RpcProvider | undefined;
  rpcMetrics?: () => import("./position-history-rpc").HistoryRpcMetric;
};
export type SyncedPositionHistory = {
  history: { signature: string; slot: number; blockTime: number | null; events: PositionCashflowEvent[] }[];
  signatureCount: number; truncated: boolean; metric: HistoryFetchMetric;
};

/** JSON receipts deliberately preserve raw token amounts as strings. */
function serializeReceipt(tx: ParsedTransactionWithMeta): Record<string, unknown> {
  return JSON.parse(JSON.stringify(tx)) as Record<string, unknown>;
}

function receiptMatches(tx: ParsedTransactionWithMeta, info: HistorySignature) {
  return tx.transaction?.signatures?.[0] === info.signature && tx.slot === info.slot &&
    Boolean(tx.meta && (tx.meta.err || (Array.isArray(tx.meta.logMessages) && tx.meta.logMessages.length > 0)));
}

const openingInstructions = ["open_position", "open_position_v2", "open_position_with_token22_nft"]
  .map(name => ({ discriminator: createHash("sha256").update(`global:${name}`).digest().subarray(0, 8),
    token22: name === "open_position_with_token22_nft" }));

/** Opening events have no NFT mint. Bind them to instruction order before declaring history complete. */
function bindOpeningEvents(events: PositionCashflowEvent[], tx: ParsedTransactionWithMeta, context: PositionEventContext) {
  const openings: boolean[] = [];
  for (const [index, outer] of tx.transaction.message.instructions.entries()) {
    const instructions = [outer, ...(tx.meta?.innerInstructions?.find(group => group.index === index)?.instructions ?? [])];
    for (const instruction of instructions) {
      if (!instruction.programId.equals(CLMM_PROGRAM_ID) || !("accounts" in instruction)) continue;
      const data = Buffer.from(bs58.decode(instruction.data));
      const kind = openingInstructions.find(item => data.subarray(0, 8).equals(item.discriminator));
      if (!kind) continue;
      const poolIndex = kind.token22 ? 4 : 5;
      if (instruction.accounts[poolIndex]?.toBase58() !== context.poolId) continue;
      openings.push(instruction.accounts[2]?.toBase58() === context.positionMint &&
        instruction.accounts[kind.token22 ? 8 : 9]?.toBase58() === context.positionAccount);
    }
  }
  const openEvents = events.filter(event => event.kind === "open");
  if (openEvents.length !== openings.length) throw new Error("Opening event receipts are incomplete or ambiguous");
  let openingIndex = 0;
  return events.filter(event => event.kind !== "open" || openings[openingIndex++]);
}

/** web3.js parsed receipts contain PublicKeys; JSONB stores their base58 values. */
export function rehydratePositionReceipt(receipt: Record<string, unknown>): ParsedTransactionWithMeta {
  const tx = JSON.parse(JSON.stringify(receipt)) as ParsedTransactionWithMeta;
  const instructions = [tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).map(group => group.instructions)];
  for (const group of instructions) {
    for (const instruction of group) {
      instruction.programId = new PublicKey(instruction.programId);
      if ("accounts" in instruction) instruction.accounts = instruction.accounts.map(key => new PublicKey(key));
    }
  }
  for (const key of tx.transaction.message.accountKeys) key.pubkey = new PublicKey(key.pubkey);
  return tx;
}

/** A bounded request resumes backfill and only fetches details absent from DB. */
export async function syncPositionHistory(options: SyncPositionHistoryOptions): Promise<SyncedPositionHistory> {
  const started = Date.now();
  const stages: NonNullable<HistoryFetchMetric["stages"]> = {
    claimMs: 0, listingMs: 0, detailsMs: 0, parseMs: 0, commitMs: 0, releaseMs: 0,
  };
  const measure = async <T>(stage: keyof typeof stages, work: () => Promise<T>): Promise<T> => {
    const before = Date.now();
    try { return await work(); } finally { stages[stage] += Math.max(0, Date.now() - before); }
  };
  const parseWork = <T>(work: () => T): T => {
    const before = Date.now();
    try { return work(); } finally { stages.parseMs += Math.max(0, Date.now() - before); }
  };
  const requestedBudget = Math.min(500, Math.max(1, Math.floor(options.maxSignatures) || 100));
  const transportBudget = options.maxDetailRequests === undefined ? 500
    : Math.min(500, Math.max(1, Math.floor(options.maxDetailRequests) || 1));
  const budget = Math.min(requestedBudget, transportBudget);
  const snapshot = await measure("claimMs", () => options.store.request({ op: "claim", context: options.context,
    parserVersion: POSITION_HISTORY_PARSER_VERSION }));
  let fetchedTxCount = 0;
  let listingCount = 0;
  let defaultCount = 0;
  let unattributedCount = 0;
  const fallbackReasons = new Set<HistoryFallbackReason>();
  let detailWindow: { started?: number; ended?: number } | undefined;
  let outcome: SyncedPositionHistory | undefined;
  const rows = new Map(snapshot.transactions.map(row => [row.signature, row]));
  const updates = new Map<string, StoredPositionTransaction>();
  const oldState = snapshot.state;
  let safe = Boolean(snapshot.lease);
  const checkAbort = () => options.signal?.throwIfAborted();
  const needsParse = (row: StoredPositionTransaction) => row.status !== "ignored" && (row.status === "pending" ||
    row.parserVersion !== POSITION_HISTORY_PARSER_VERSION);
  let moreWork = false;

  const result = (state: PositionHistorySnapshot["state"], transactions: StoredPositionTransaction[]) => {
    const hasOpening = transactions.some(row => row.status === "parsed" && !needsParse(row) &&
      row.events.some(event => event.kind === "open"));
    const incomplete = !safe || !state.complete || !hasOpening || transactions.some(needsParse);
    const history = transactions.filter(row => row.status === "parsed" && !needsParse(row) && row.events.length)
      .map(({ signature, slot, blockTime, events }) => ({ signature, slot, blockTime, events }))
      .sort((a, b) => a.slot - b.slot || (a.blockTime ?? 0) - (b.blockTime ?? 0));
    const metric: HistoryFetchMetric = { txCount: transactions.filter(row => row.status === "parsed").length,
      elapsedMs: Date.now() - started,
      provider: defaultCount ? "default" : unattributedCount ? "unknown" : "default",
      source: "databaseIncremental", defaultTxCount: defaultCount,
      fallbackReasons: [...fallbackReasons], cachedTxCount: snapshot.transactions.filter(row => !needsParse(row)).length,
      fetchedTxCount, listingCount, detailBudget: budget, historyComplete: !incomplete, canContinue: incomplete && moreWork,
      unattributedTxCount: unattributedCount, stages: { ...stages }, rpc: options.rpcMetrics?.() };
    outcome = { history, signatureCount: transactions.length, truncated: incomplete, metric };
    return outcome;
  };
  if (!snapshot.lease) return result(oldState, snapshot.transactions);

  try {
    const process = async (info: HistorySignature): Promise<StoredPositionTransaction> => {
      checkAbort();
      const existing = rows.get(info.signature);
      if (existing && !needsParse(existing)) return existing;
      if (existing && updates.has(info.signature)) return existing;
      let tx: ParsedTransactionWithMeta | null = null;
      let receipt = existing?.receipt ?? null;
      if (receipt) {
        try {
          tx = parseWork(() => rehydratePositionReceipt(receipt!));
          if (!receiptMatches(tx, info)) { tx = null; receipt = null; }
        } catch { tx = null; receipt = null; }
      }
      if (!tx && !info.err) {
        if (fetchedTxCount >= budget) return existing ?? { signature: info.signature, slot: info.slot,
          blockTime: info.blockTime ?? null, status: "pending", receipt: null, events: [],
          parserVersion: POSITION_HISTORY_PARSER_VERSION };
        fetchedTxCount++;
        const connections = [options.connection, ...(options.fallbackConnection && options.fallbackConnection !== options.connection
          ? [options.fallbackConnection] : [])];
        if (detailWindow && detailWindow.started === undefined) detailWindow.started = Date.now();
        try {
          for (const [index, connection] of connections.entries()) {
            checkAbort();
            try {
              const candidate = await connection.getParsedTransaction(info.signature, {
                commitment: "finalized", maxSupportedTransactionVersion: 0 });
              if (candidate && receiptMatches(candidate, info)) {
                tx = candidate;
                const servedBy = options.receiptProvider ? options.receiptProvider(info.signature) : "default";
                if (servedBy === "default") defaultCount++;
                else unattributedCount++;
                break;
              }
              if (index === 0 && connections.length > 1) fallbackReasons.add(candidate ? "history-primary-invalid-receipt" : "history-primary-empty");
            } catch {
              checkAbort();
              if (index === 0 && connections.length > 1) fallbackReasons.add("history-primary-error");
            }
          }
        } finally { if (detailWindow) detailWindow.ended = Date.now(); }
        if (tx) receipt = parseWork(() => serializeReceipt(tx!));
      }
      const row: StoredPositionTransaction = { signature: info.signature, slot: info.slot,
        blockTime: tx?.blockTime ?? info.blockTime ?? null, receipt, events: [],
        parserVersion: POSITION_HISTORY_PARSER_VERSION, status: "pending" };
      if (info.err || tx?.meta?.err) row.status = "failed";
      else if (tx?.meta && Array.isArray(tx.meta.logMessages)) {
        try {
          row.events = parseWork(() => bindOpeningEvents(parsePositionCashflowEvents(tx!.meta!.logMessages, tx!, options.context), tx!, options.context));
          row.status = "parsed";
        } catch { /* Keep receipts pending for a future parser version. */ }
      }
      // An RPC receipt missing meta/logs is not replayable: retry upstream next request.
      else row.receipt = null;
      rows.set(row.signature, row);
      updates.set(row.signature, row);
      return row;
    };
    const runReceipts = async (infos: readonly HistorySignature[]) => {
      const window: { started?: number; ended?: number } = {};
      detailWindow = window;
      try { return await mapPositionHistoryWorkers(infos, process, { signal: options.signal }); }
      finally {
        if (window.started !== undefined && window.ended !== undefined) stages.detailsMs += Math.max(0, window.ended - window.started);
        detailWindow = undefined;
      }
    };

    // Repair missing receipts and reparse retained receipts before advancing any cursor.
    const repair = snapshot.transactions.filter(needsParse)
      .sort((a, b) => Number(Boolean(b.receipt)) - Number(Boolean(a.receipt)) || b.slot - a.slot).slice(0, budget);
    await runReceipts(repair.map(row => ({ ...row, err: row.status === "failed" ? {} : null })));

    let newest: string | null = oldState.deltaHead ?? null;
    let topSafe = true;
    let boundaryFound = oldState.headSignature === null;
    let openingFound = false;
    let contiguousBefore: string | null = oldState.backfillBefore;
    let deltaBefore: string | null = oldState.deltaBefore ?? null;
    let newerSinceDeltaStarted = false;
    let normalizationPending = false;
    let normalizationProgress = false;
    const ignorePrecreation = (earlier: StoredPositionTransaction) => {
      if (earlier.status === "ignored") return;
      if (!updates.has(earlier.signature) && updates.size >= 500) {
        normalizationPending = true;
        return;
      }
      const ignored: StoredPositionTransaction = { ...earlier, status: "ignored", events: [],
        parserVersion: POSITION_HISTORY_PARSER_VERSION };
      rows.set(earlier.signature, ignored); updates.set(earlier.signature, ignored);
      normalizationProgress = true;
    };
    if (oldState.deltaBefore && oldState.deltaHead) {
      const latest = await measure("listingMs", () => (options.fallbackConnection ?? options.connection).getSignaturesForAddress(
        new PublicKey(options.context.positionAccount), { limit: 1 }, "finalized"));
      listingCount++;
      newerSinceDeltaStarted = latest[0]?.signature !== oldState.deltaHead;
    }
    // Never treat a provider's short/empty page as proof of complete history.
    const scan = async (initialBefore?: string, boundary?: string | null) => {
      let before = initialBefore;
      const seen = new Set<string>();
      let contiguous = true;
      // Cached retries can traverse more rows than the detail budget, but still have a hard bound.
      for (let page = 0; page < 4; page++) {
        checkAbort();
        const listingConnection = options.fallbackConnection ?? options.connection;
        const infos = await measure("listingMs", () => listingConnection.getSignaturesForAddress(new PublicKey(options.context.positionAccount),
          { before, limit: 500 }, "finalized"));
        listingCount++;
        if (!infos.length) return false;
        if (!initialBefore && !newest) newest = infos[0]!.signature;
        const selected: HistorySignature[] = [];
        let hitBoundary = false;
        let reserved = fetchedTxCount;
        let reservedUpdates = updates.size;
        for (const info of infos) {
          if (info.signature === boundary) { hitBoundary = true; break; }
          if (seen.has(info.signature)) continue;
          seen.add(info.signature);
          const existing = rows.get(info.signature);
          const changesRow = !existing || needsParse(existing);
          const fetchNeeded = !info.err && (!existing || needsParse(existing)) && !existing?.receipt;
          if (changesRow && !updates.has(info.signature) && reservedUpdates >= 500) break;
          if (fetchNeeded && reserved >= budget) break;
          if (fetchNeeded) reserved++;
          if (changesRow && !updates.has(info.signature)) reservedUpdates++;
          selected.push(info);
        }
        const processed = await runReceipts(selected);
        for (const [index, row] of processed.entries()) {
          if (needsParse(row)) contiguous = false;
          if (contiguous) {
            if (!boundary) contiguousBefore = row.signature;
            else deltaBefore = row.signature;
            if (row.events.some(event => event.kind === "open")) {
              openingFound = true;
              if (!boundary) {
                // A predictable PDA may appear before creation. Those earlier receipts are outside this position's lifetime.
                for (const earlier of processed.slice(index + 1)) {
                  const saved = snapshot.transactions.find(item => item.signature === earlier.signature);
                  if (saved) {
                    ignorePrecreation(earlier);
                  } else { rows.delete(earlier.signature); updates.delete(earlier.signature); }
                }
                for (const earlier of rows.values()) {
                  if (earlier.slot >= row.slot || earlier.status === "ignored") continue;
                  ignorePrecreation(earlier);
                }
                break;
              }
            }
          }
        }
        topSafe = topSafe && contiguous;
        if (hitBoundary) { boundaryFound = true; return contiguous; }
        if (!boundary && openingFound) return contiguous;
        if (selected.length !== infos.length || !contiguous) return false;
        const nextBefore = infos.at(-1)!.signature;
        if (nextBefore === before) return false;
        before = nextBefore;
      }
      return false;
    };

    const deltaSafe = await scan(oldState.deltaBefore ?? undefined, oldState.headSignature);
    // A partial initial scan may save its contiguous prefix and resume it next time.
    if (oldState.headSignature && deltaSafe && !oldState.complete && oldState.backfillBefore) {
      await scan(oldState.backfillBefore);
    }
    const unresolved = [...rows.values()].some(needsParse);
    const checkpointSafe = topSafe && !unresolved && !normalizationPending && (oldState.headSignature === null || boundaryFound);
    safe = checkpointSafe && !newerSinceDeltaStarted;
    const state = {
      headSignature: checkpointSafe && newest ? newest : oldState.headSignature,
      backfillBefore: topSafe && !unresolved && !normalizationPending ? contiguousBefore : oldState.backfillBefore,
      complete: checkpointSafe ? (oldState.complete || openingFound) && [...rows.values()].some(row =>
        row.status === "parsed" && !needsParse(row) && row.events.some(event => event.kind === "open")) : oldState.complete,
      deltaBefore: oldState.headSignature && !boundaryFound && topSafe && !unresolved ? deltaBefore : null,
      deltaHead: oldState.headSignature && !boundaryFound && topSafe && !unresolved && deltaBefore ? newest : null,
      parserVersion: POSITION_HISTORY_PARSER_VERSION,
    };
    if (rows.size > MAX_POSITION_HISTORY_TRANSACTIONS) throw new Error("Position history exceeds the supported transaction limit");
    const changedTransactions = [...updates.values()].some(row => {
      const previous = snapshot.transactions.find(saved => saved.signature === row.signature);
      return !previous || previous.status !== row.status || previous.parserVersion !== row.parserVersion;
    });
    moreWork = (!unresolved || normalizationProgress) && (changedTransactions || state.deltaBefore !== oldState.deltaBefore ||
      state.backfillBefore !== oldState.backfillBefore || newerSinceDeltaStarted);
    const unchangedState = state.headSignature === oldState.headSignature && state.backfillBefore === oldState.backfillBefore &&
      state.complete === oldState.complete && state.parserVersion === oldState.parserVersion &&
      state.deltaBefore === (oldState.deltaBefore ?? null) && state.deltaHead === (oldState.deltaHead ?? null);
    // A no-change lookup needs only release; avoid republishing the identical full ledger.
    if (!updates.size && unchangedState) return result(oldState, snapshot.transactions);
    const committed = await measure("commitMs", () => options.store.request({ op: "commit", lease: snapshot.lease!,
      state, transactions: [...updates.values()] }));
    return result(committed.state, committed.transactions);
  } finally {
    // The lease expires even if an upstream/storage failure prevents release.
    // A release failure must not mask a successful commit or the original error.
    await measure("releaseMs", () => options.store.request({ op: "release", lease: snapshot.lease! })).catch(() => undefined);
    if (outcome) {
      outcome.metric.elapsedMs = Date.now() - started;
      outcome.metric.stages = { ...stages };
      outcome.metric.rpc = options.rpcMetrics?.();
    }
  }
}
