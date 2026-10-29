import "@/lib/engine-host";
import type { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { invokeWithPolicy } from "@sofinance/engine/rpc/connection";
import { policyFor } from "@sofinance/engine/rpc/methods";
import type { RpcProvider } from "@sofinance/engine/rpc/types";

export const HISTORY_BATCH_SIZE = 8;

export type HistoryFetchSource = "getParsedTransactionBatch" | "databaseIncremental";

export type HistoryProvider = "default" | "unknown";

/** Why history detail fetches left the first RPC for the fallback (incremental sync only). */
export type HistoryFallbackReason =
  | "history-primary-empty"
  | "history-primary-invalid-receipt"
  | "history-primary-error";

export type HistorySignature = {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err?: unknown;
};

export type ParsedHistoryTx = {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
  logMessages: string[] | null;
  servedBy?: "default";
  /** Preserve instruction receipts when event logs were truncated. */
  parsedTransaction?: ParsedTransactionWithMeta;
};

export type HistoryFetchMetric = {
  txCount: number;
  elapsedMs: number;
  provider: HistoryProvider;
  source: HistoryFetchSource;
  defaultTxCount: number;
  fallbackReasons: HistoryFallbackReason[];
  cachedTxCount?: number;
  fetchedTxCount?: number;
  detailBudget?: number;
  listingCount?: number;
  historyComplete?: boolean;
  canContinue?: boolean;
  memoryCacheHit?: boolean;
  memoryCacheAgeMs?: number;
  historySyncedAt?: string;
  refreshSignaturesResolved?: boolean;
  unattributedTxCount?: number;
  /** detailsMs is wall span per worker phase; accumulated parseMs can overlap it. */
  stages?: { claimMs: number; listingMs: number; detailsMs: number; parseMs: number; commitMs: number; releaseMs: number };
  rpc?: import("./position-history-rpc").HistoryRpcMetric;
};

export type HistoryServedBy = "default";

export type HistoryConnection = {
  getSignaturesForAddress: Connection["getSignaturesForAddress"];
  getParsedTransaction: Connection["getParsedTransaction"];
};

export type FetchPositionHistoryOptions = {
  address: PublicKey;
  maxSignatures: number;
  connection: HistoryConnection;
  provider: RpcProvider;
  /** RPC used first for parsed tx details (the primary connection is the fallback). */
  fallbackConnection?: HistoryConnection;
  batchSize?: number;
  nowMs?: () => number;
};

export type PositionHistoryFetch = {
  items: ParsedHistoryTx[];
  truncated: boolean;
  signatureCount: number;
  metric: HistoryFetchMetric;
};

/**
 * Run `fn` over `items` in chunks of `batchSize` so we never open unbounded
 * parallel RPC calls (the previous sequential loop was N+1).
 */
export async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : HISTORY_BATCH_SIZE;
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const part = await Promise.all(slice.map((item, offset) => fn(item, i + offset)));
    out.push(...part);
  }
  return out;
}

function parsedMetaToHistory(
  signature: string,
  slot: number,
  fallbackBlockTime: number | null | undefined,
  tx: ParsedTransactionWithMeta | null,
): ParsedHistoryTx | null {
  if (!tx) return null;
  return {
    signature,
    slot: tx.slot || slot,
    blockTime: tx.blockTime ?? fallbackBlockTime ?? null,
    err: tx.meta?.err ?? null,
    logMessages: tx.meta?.logMessages ?? null,
    parsedTransaction: tx,
  };
}

export type FetchParsedOptions = {
  batchSize?: number;
  fallback?: HistoryConnection | null;
  primaryProvider?: HistoryServedBy;
  /** Signatures that should parse on the fallback RPC first. */
  parseOnFallbackFirst?: ReadonlySet<string>;
};

function normalizeFetchParsedOptions(batchSizeOrOptions?: number | FetchParsedOptions): FetchParsedOptions & {
  batchSize: number;
} {
  if (typeof batchSizeOrOptions === "number" || batchSizeOrOptions === undefined) {
    return { batchSize: batchSizeOrOptions ?? HISTORY_BATCH_SIZE };
  }
  return { ...batchSizeOrOptions, batchSize: batchSizeOrOptions.batchSize ?? HISTORY_BATCH_SIZE };
}

async function parseOne(
  connection: HistoryConnection,
  info: HistorySignature,
): Promise<ParsedHistoryTx | null> {
  const tx = await connection.getParsedTransaction(info.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return parsedMetaToHistory(info.signature, info.slot, info.blockTime, tx);
}

export async function fetchParsedTransactionsBatched(
  connection: HistoryConnection,
  signatures: readonly HistorySignature[],
  batchSizeOrOptions: number | FetchParsedOptions = HISTORY_BATCH_SIZE,
): Promise<ParsedHistoryTx[]> {
  const options = normalizeFetchParsedOptions(batchSizeOrOptions);
  const primaryProvider = options.primaryProvider ?? "default";
  const fallback = options.fallback ?? null;
  const fallbackFirst = options.parseOnFallbackFirst;
  const policy = policyFor("getParsedTransaction");

  const fetched = await mapInBatches(signatures, options.batchSize, async (info): Promise<ParsedHistoryTx | null> => {
    if (info.err) return null;

    const tryFallbackFirst = Boolean(fallback && fallbackFirst?.has(info.signature));
    const firstConn = tryFallbackFirst ? fallback! : connection;
    const firstLabel: HistoryServedBy = tryFallbackFirst ? "default" : primaryProvider;
    const secondConn = tryFallbackFirst ? connection : fallback;
    const secondLabel: HistoryServedBy = tryFallbackFirst ? primaryProvider : "default";

    try {
      const result = await invokeWithPolicy({
        method: "getParsedTransaction",
        primary: () => parseOne(firstConn, info),
        fallback: secondConn && secondConn !== firstConn ? () => parseOne(secondConn, info) : undefined,
        primaryId: firstLabel,
        fallbackId: secondLabel,
        policy,
      });
      if (!result.value) return null;
      return { ...result.value, servedBy: result.servedBy };
    } catch {
      return null;
    }
  });
  return fetched.filter((item): item is ParsedHistoryTx => item !== null);
}

async function listSignatures(
  connection: HistoryConnection,
  address: PublicKey,
  maxSignatures: number,
): Promise<HistorySignature[]> {
  const infos = await connection.getSignaturesForAddress(address, { limit: maxSignatures }, "confirmed");
  return infos.map((info) => ({
    signature: info.signature,
    slot: info.slot,
    blockTime: info.blockTime,
    err: info.err,
  }));
}

export function mergeHistorySignatures(
  primary: readonly HistorySignature[],
  extra: readonly HistorySignature[],
  maxSignatures: number,
): HistorySignature[] {
  const bySig = new Map<string, HistorySignature>();
  for (const item of primary) bySig.set(item.signature, item);
  for (const item of extra) {
    if (!bySig.has(item.signature)) bySig.set(item.signature, item);
  }
  return [...bySig.values()]
    .sort((a, b) => {
      const slot = b.slot - a.slot;
      if (slot !== 0) return slot;
      return (b.blockTime ?? 0) - (a.blockTime ?? 0);
    })
    .slice(0, maxSignatures);
}

function uniqueReasons(reasons: readonly HistoryFallbackReason[]): HistoryFallbackReason[] {
  return [...new Set(reasons)];
}

function buildMetric(input: {
  items: ParsedHistoryTx[];
  elapsedMs: number;
  source: HistoryFetchSource;
  fallbackReasons: HistoryFallbackReason[];
}): HistoryFetchMetric {
  const defaultTxCount = input.items.filter((item) => item.servedBy === "default").length;
  return {
    txCount: input.items.length,
    elapsedMs: input.elapsedMs,
    provider: "default",
    source: input.source,
    defaultTxCount,
    fallbackReasons: uniqueReasons(input.fallbackReasons),
  };
}

/**
 * Load personal-position history: `getSignaturesForAddress` listing plus
 * bounded-parallel `getParsedTransaction` details, both through the shared
 * RPC policy layer — this file only windows the list and records metrics.
 */
export async function fetchPositionHistoryTransactions(
  options: FetchPositionHistoryOptions,
): Promise<PositionHistoryFetch> {
  const started = (options.nowMs ?? Date.now)();
  const batchSize = options.batchSize ?? HISTORY_BATCH_SIZE;
  const fallback = options.fallbackConnection;

  const listed = await listSignatures(options.connection, options.address, options.maxSignatures);
  const merged = listed.slice(0, options.maxSignatures);
  const truncated = listed.length >= options.maxSignatures;

  const parsed = await fetchParsedTransactionsBatched(options.connection, merged, {
    batchSize,
    fallback,
    primaryProvider: "default",
    parseOnFallbackFirst: new Set(merged.map((item) => item.signature)),
  });

  const elapsedMs = Math.max(0, (options.nowMs ?? Date.now)() - started);
  return {
    items: parsed,
    truncated,
    signatureCount: merged.length,
    metric: buildMetric({ items: parsed, elapsedMs, source: "getParsedTransactionBatch", fallbackReasons: [] }),
  };
}

export function toChronological(items: readonly ParsedHistoryTx[]): ParsedHistoryTx[] {
  return [...items].sort((a, b) => {
    const slot = a.slot - b.slot;
    if (slot !== 0) return slot;
    const time = (a.blockTime ?? 0) - (b.blockTime ?? 0);
    return time;
  });
}
