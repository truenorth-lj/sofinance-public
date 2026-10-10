import type { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import type { RpcProvider } from "./rpc";

export const HISTORY_BATCH_SIZE = 8;

export type HistoryFetchSource = "getTransactionsForAddress" | "getParsedTransactionBatch";

export type HistoryProvider = "solami" | "default" | "solami+default";

export type HistoryFallbackReason =
  | "solami-empty"
  | "solami-error"
  | "solami-unparseable"
  | "solami-parse-error"
  | "solami-http-error"
  | "solami-limited-window";

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

export type ParsedHistoryTx = {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
  logMessages: string[] | null;
  servedBy?: HistoryServedBy;
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

async function tryParsedTransaction(
  connection: HistoryConnection,
  info: HistorySignature,
): Promise<ParsedHistoryTx | "error" | null> {
  try {
    const tx = await connection.getParsedTransaction(info.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return parsedMetaToHistory(info.signature, info.slot, info.blockTime, tx);
  } catch {
    return "error";
  }
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

  const fetched = await mapInBatches(signatures, options.batchSize, async (info): Promise<ParsedHistoryTx | null> => {
    if (info.err) return null;

    const tryFallbackFirst = Boolean(fallback && fallbackFirst?.has(info.signature));
    const firstConn = tryFallbackFirst ? fallback! : connection;
    const firstLabel: HistoryServedBy = tryFallbackFirst ? "default" : primaryProvider;
    const first = await tryParsedTransaction(firstConn, info);
    if (first && first !== "error") return { ...first, servedBy: firstLabel };

    const secondConn = tryFallbackFirst ? connection : fallback;
    if (!secondConn || secondConn === firstConn) return null;
    const secondLabel: HistoryServedBy = tryFallbackFirst ? primaryProvider : "default";
    const second = await tryParsedTransaction(secondConn, info);
    if (second && second !== "error") return { ...second, servedBy: secondLabel };
    return null;
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

function classifySolamiFailure(error: unknown): HistoryFallbackReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(4\d\d|5\d\d)\b/.test(message)) return "solami-http-error";
  return "solami-error";
}

type SolamiListResult =
  | { ok: true; items: ParsedHistoryTx[] }
  | { ok: false; reason: HistoryFallbackReason };

async function tryGetTransactionsForAddress(
  customRpc: CustomRpcCall,
  address: string,
  maxSignatures: number,
): Promise<SolamiListResult> {
  try {
    const raw = await customRpc("getTransactionsForAddress", solamiHistoryParams(address, maxSignatures));
    const { rows } = unwrapTransactionsForAddressResult(raw);
    // Empty is a limited history window, not "this account has no txs".
    if (!rows.length) return { ok: false, reason: "solami-empty" };
    const parsed = rows.map(parseHistoryTxCandidate).filter((item): item is ParsedHistoryTx => item !== null);
    if (parsed.length === 0) return { ok: false, reason: "solami-unparseable" };
    return { ok: true, items: parsed };
  } catch (error) {
    return { ok: false, reason: classifySolamiFailure(error) };
  }
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

function toSignature(item: ParsedHistoryTx): HistorySignature {
  return {
    signature: item.signature,
    slot: item.slot,
    blockTime: item.blockTime,
    err: item.err,
  };
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
 * Load personal-position history. On Solami, try `getTransactionsForAddress`
 * first (`{ limit, transactionDetails: "signatures" }`). Empty pages, RPC
 * errors, and web3.js validation failures fall back to the default RPC
 * (`SOLANA_RPC_URL` then public) per listing-call / per parsed tx so older
 * history is never dropped.
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
    const listed = await tryGetTransactionsForAddress(customRpc, options.address.toBase58(), options.maxSignatures);
    if (listed.ok) {
      solamiListed = listed.items.map(toSignature);
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
