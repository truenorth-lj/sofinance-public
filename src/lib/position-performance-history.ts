import type { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { invokeWithPolicy } from "./rpc/connection";
import { policyFor } from "./rpc/methods";
import type { RpcProvider } from "./rpc/types";
import {
  listSolamiAddressSignatures,
  parseHistoryTxCandidate,
  toHistorySignature,
  unwrapTransactionsForAddressResult,
  type CustomRpcCall,
  type HistoryFallbackReason,
  type HistorySignature,
  type ParsedHistoryTx,
} from "./solami/history";

export const HISTORY_BATCH_SIZE = 8;

export type HistoryFetchSource = "getTransactionsForAddress" | "getParsedTransactionBatch";

export type HistoryProvider = "solami" | "default" | "solami+default";

export type {
  CustomRpcCall,
  HistoryFallbackReason,
  HistorySignature,
  ParsedHistoryTx,
};

export type HistoryFetchMetric = {
  txCount: number;
  elapsedMs: number;
  provider: HistoryProvider;
  source: HistoryFetchSource;
  solamiTxCount: number;
  defaultTxCount: number;
  fallbackReasons: HistoryFallbackReason[];
};

export type HistoryServedBy = "solami" | "default";

export type HistoryConnection = {
  getSignaturesForAddress: Connection["getSignaturesForAddress"];
  getParsedTransaction: Connection["getParsedTransaction"];
};

export type FetchPositionHistoryOptions = {
  address: PublicKey;
  maxSignatures: number;
  connection: HistoryConnection;
  provider: RpcProvider;
  customRpc?: CustomRpcCall;
  /** Non-Solami RPC used when Solami listing is empty or a parsed tx fails. */
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

export {
  parseHistoryTxCandidate,
  unwrapTransactionsForAddressResult,
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
  };
}

export type FetchParsedOptions = {
  batchSize?: number;
  fallback?: HistoryConnection | null;
  primaryProvider?: HistoryServedBy;
  /** Signatures that should skip Solami and parse on the fallback RPC first (older window). */
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

async function defaultCustomRpc(connection: HistoryConnection): Promise<CustomRpcCall | null> {
  const rpc = connection as HistoryConnection & {
    _rpcRequest?: (method: string, args: unknown[]) => Promise<unknown>;
  };
  if (typeof rpc._rpcRequest !== "function") return null;
  return async (method, params) => rpc._rpcRequest!(method, params);
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

function historyProviderOf(solamiTxCount: number, defaultTxCount: number): HistoryProvider {
  if (solamiTxCount > 0 && defaultTxCount > 0) return "solami+default";
  if (solamiTxCount > 0) return "solami";
  return "default";
}

function buildMetric(input: {
  items: ParsedHistoryTx[];
  elapsedMs: number;
  source: HistoryFetchSource;
  fallbackReasons: HistoryFallbackReason[];
}): HistoryFetchMetric {
  const solamiTxCount = input.items.filter((item) => item.servedBy === "solami").length;
  const defaultTxCount = input.items.filter((item) => item.servedBy === "default").length;
  return {
    txCount: input.items.length,
    elapsedMs: input.elapsedMs,
    provider: historyProviderOf(solamiTxCount, defaultTxCount),
    source: input.source,
    solamiTxCount,
    defaultTxCount,
    fallbackReasons: uniqueReasons(input.fallbackReasons),
  };
}

/**
 * Load personal-position history. Solami listing (`getTransactionsForAddress`)
 * and per-tx `getParsedTransaction` fallbacks go through the shared RPC
 * policy layer — this file only merges windows and records metrics.
 */
export async function fetchPositionHistoryTransactions(
  options: FetchPositionHistoryOptions,
): Promise<PositionHistoryFetch> {
  const started = (options.nowMs ?? Date.now)();
  const batchSize = options.batchSize ?? HISTORY_BATCH_SIZE;
  const customRpc = options.customRpc ?? (await defaultCustomRpc(options.connection));
  const fallback = options.fallbackConnection;
  const reasons: HistoryFallbackReason[] = [];

  let solamiListed: HistorySignature[] = [];
  let usedSolamiListing = false;

  if (options.provider === "solami" && customRpc) {
    const listed = await listSolamiAddressSignatures(customRpc, options.address.toBase58(), options.maxSignatures);
    if (listed.ok) {
      solamiListed = listed.items.map(toHistorySignature);
      usedSolamiListing = true;
    } else {
      reasons.push(listed.reason);
    }
  }

  let defaultListed: HistorySignature[] = [];
  if (options.provider !== "solami") {
    defaultListed = await listSignatures(options.connection, options.address, options.maxSignatures);
  } else if (fallback) {
    try {
      defaultListed = await listSignatures(fallback, options.address, options.maxSignatures);
    } catch {
      if (!usedSolamiListing) {
        defaultListed = await listSignatures(options.connection, options.address, options.maxSignatures).catch(
          () => [],
        );
      }
    }
  } else if (!usedSolamiListing) {
    defaultListed = await listSignatures(options.connection, options.address, options.maxSignatures);
  }

  const solamiSigs = new Set(solamiListed.map((item) => item.signature));
  if (usedSolamiListing && defaultListed.some((item) => !solamiSigs.has(item.signature))) {
    reasons.push("solami-limited-window");
  }

  const merged = usedSolamiListing
    ? mergeHistorySignatures(solamiListed, defaultListed, options.maxSignatures)
    : defaultListed.slice(0, options.maxSignatures);
  const truncated = usedSolamiListing
    ? solamiListed.length >= options.maxSignatures || defaultListed.length >= options.maxSignatures
    : defaultListed.length >= options.maxSignatures;

  const parseOnFallbackFirst = new Set(
    merged.filter((item) => !solamiSigs.has(item.signature)).map((item) => item.signature),
  );

  const parsed = await fetchParsedTransactionsBatched(options.connection, merged, {
    batchSize,
    fallback,
    primaryProvider: options.provider === "solami" ? "solami" : "default",
    parseOnFallbackFirst,
  });

  if (parsed.some((item) => solamiSigs.has(item.signature) && item.servedBy === "default")) {
    reasons.push("solami-parse-error");
  }

  const elapsedMs = Math.max(0, (options.nowMs ?? Date.now)() - started);
  const source: HistoryFetchSource = usedSolamiListing ? "getTransactionsForAddress" : "getParsedTransactionBatch";
  return {
    items: parsed,
    truncated,
    signatureCount: merged.length,
    metric: buildMetric({ items: parsed, elapsedMs, source, fallbackReasons: reasons }),
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
