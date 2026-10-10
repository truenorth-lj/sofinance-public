import type { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import type { RpcProvider } from "./rpc";

export const HISTORY_BATCH_SIZE = 8;

export type HistoryFetchSource = "getTransactionsForAddress" | "getParsedTransactionBatch";

export type HistoryFetchMetric = {
  txCount: number;
  elapsedMs: number;
  provider: RpcProvider;
  source: HistoryFetchSource;
};

export type ParsedHistoryTx = {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
  logMessages: string[] | null;
};

export type CustomRpcCall = (method: string, params: unknown[]) => Promise<unknown>;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function asLogMessages(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const logs = value.filter((item): item is string => typeof item === "string");
  return logs.length === value.length ? logs : null;
}

function unwrapRpcPayload(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  if (record.error) {
    const err = asRecord(record.error);
    throw new Error(asString(err?.message) ?? "RPC error");
  }
  if ("result" in record) return record.result;
  return raw;
}

/**
 * Accept the live Solami `getTransactionsForAddress` envelope
 * `{ result: { data: SignatureRow[], paginationToken } }` plus a few
 * Triton-style aliases. Rows are signatures-only (`transactionDetails: "signatures"`).
 */
export function unwrapTransactionsForAddressResult(raw: unknown): {
  rows: unknown[];
  paginationToken: string | null;
} {
  const payload = unwrapRpcPayload(raw);
  if (Array.isArray(payload)) return { rows: payload, paginationToken: null };
  const record = asRecord(payload);
  if (!record) return { rows: [], paginationToken: null };

  const nestedValue = asRecord(record.value);
  const rows =
    (Array.isArray(record.data) && record.data) ||
    (Array.isArray(record.transactions) && record.transactions) ||
    (Array.isArray(record.items) && record.items) ||
    (nestedValue && Array.isArray(nestedValue.data) && nestedValue.data) ||
    (nestedValue && Array.isArray(nestedValue.accounts) && nestedValue.accounts) ||
    (Array.isArray(record.value) && record.value) ||
    [];

  const token =
    asString(record.paginationToken) ??
    asString(record.pagination_token) ??
    (nestedValue ? asString(nestedValue.paginationToken) ?? asString(nestedValue.pagination_token) : null);

  return { rows, paginationToken: token };
}

export function parseHistoryTxCandidate(raw: unknown): ParsedHistoryTx | null {
  const record = asRecord(raw);
  if (!record) return null;

  const nestedTx = asRecord(record.transaction);
  const nestedMeta = asRecord(record.meta) ?? asRecord(nestedTx?.meta);
  const signatures = Array.isArray(nestedTx?.signatures) ? nestedTx.signatures : null;

  const signature =
    asString(record.signature) ??
    (signatures && asString(signatures[0])) ??
    asString(record.transactionId) ??
    null;
  if (!signature) return null;

  const slot = asFiniteInt(record.slot) ?? asFiniteInt(nestedTx?.slot) ?? 0;
  const blockTime = asFiniteInt(record.blockTime) ?? asFiniteInt(record.block_time) ?? asFiniteInt(nestedTx?.blockTime);
  const err = record.err ?? nestedMeta?.err ?? null;
  const logMessages =
    asLogMessages(nestedMeta?.logMessages) ??
    asLogMessages(record.logMessages) ??
    asLogMessages(record.logs);

  return {
    signature,
    slot,
    blockTime: blockTime === null ? null : blockTime,
    err,
    logMessages,
  };
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

export type HistorySignature = {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err?: unknown;
};

export async function fetchParsedTransactionsBatched(
  connection: HistoryConnection,
  signatures: readonly HistorySignature[],
  batchSize = HISTORY_BATCH_SIZE,
): Promise<ParsedHistoryTx[]> {
  const fetched = await mapInBatches(signatures, batchSize, async (info) => {
    if (info.err) return null;
    const tx = await connection.getParsedTransaction(info.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return parsedMetaToHistory(info.signature, info.slot, info.blockTime, tx);
  });
  return fetched.filter((item): item is ParsedHistoryTx => item !== null);
}

function solamiHistoryParams(address: string, maxSignatures: number) {
  return [
    address,
    {
      limit: maxSignatures,
      transactionDetails: "signatures",
    },
  ];
}

async function tryGetTransactionsForAddress(
  customRpc: CustomRpcCall,
  address: string,
  maxSignatures: number,
): Promise<ParsedHistoryTx[] | null> {
  try {
    const raw = await customRpc("getTransactionsForAddress", solamiHistoryParams(address, maxSignatures));
    const { rows } = unwrapTransactionsForAddressResult(raw);
    if (!rows.length) return [];
    const parsed = rows.map(parseHistoryTxCandidate).filter((item): item is ParsedHistoryTx => item !== null);
    // A successful call that we cannot interpret must fall back — do not treat
    // "method exists but shape is unknown" as an empty history.
    if (parsed.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function defaultCustomRpc(connection: HistoryConnection): Promise<CustomRpcCall | null> {
  const rpc = connection as HistoryConnection & {
    _rpcRequest?: (method: string, args: unknown[]) => Promise<unknown>;
  };
  if (typeof rpc._rpcRequest !== "function") return null;
  return async (method, params) => rpc._rpcRequest!(method, params);
}

/**
 * Load personal-position history. On Solami, try the custom
 * `getTransactionsForAddress` method with `{ limit, transactionDetails: "signatures" }`
 * (one listing round-trip; logs are filled via batched `getParsedTransaction`).
 * Always fall back to `getSignaturesForAddress` + bounded-parallel
 * `getParsedTransaction` so public / third-party RPCs keep working.
 */
export async function fetchPositionHistoryTransactions(
  options: FetchPositionHistoryOptions,
): Promise<PositionHistoryFetch> {
  const started = (options.nowMs ?? Date.now)();
  const batchSize = options.batchSize ?? HISTORY_BATCH_SIZE;
  const customRpc = options.customRpc ?? (await defaultCustomRpc(options.connection));

  if (options.provider === "solami" && customRpc) {
    const fromSolami = await tryGetTransactionsForAddress(
      customRpc,
      options.address.toBase58(),
      options.maxSignatures,
    );
    if (fromSolami) {
      const withLogs = fromSolami.filter((item) => item.logMessages);
      const missingLogs = fromSolami.filter((item) => !item.logMessages && !item.err);
      let items = withLogs;
      if (missingLogs.length) {
        const filled = await fetchParsedTransactionsBatched(options.connection, missingLogs, batchSize);
        items = [...withLogs, ...filled];
      }
      const elapsedMs = Math.max(0, (options.nowMs ?? Date.now)() - started);
      return {
        items,
        truncated: fromSolami.length >= options.maxSignatures,
        signatureCount: fromSolami.length,
        metric: {
          txCount: items.length,
          elapsedMs,
          provider: options.provider,
          source: "getTransactionsForAddress",
        },
      };
    }
  }

  const sigInfos = await options.connection.getSignaturesForAddress(
    options.address,
    { limit: options.maxSignatures },
    "confirmed",
  );
  const items = await fetchParsedTransactionsBatched(options.connection, sigInfos, batchSize);
  const elapsedMs = Math.max(0, (options.nowMs ?? Date.now)() - started);
  return {
    items,
    truncated: sigInfos.length >= options.maxSignatures,
    signatureCount: sigInfos.length,
    metric: {
      txCount: items.length,
      elapsedMs,
      provider: options.provider,
      source: "getParsedTransactionBatch",
    },
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
