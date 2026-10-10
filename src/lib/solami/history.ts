import { classifyRpcError } from "../rpc/errors";

export type HistoryFallbackReason =
  | "solami-empty"
  | "solami-error"
  | "solami-unparseable"
  | "solami-parse-error"
  | "solami-http-error"
  | "solami-limited-window";

export type CustomRpcCall = (method: string, params: unknown[]) => Promise<unknown>;

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
  servedBy?: "solami" | "default";
};

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

export function solamiHistoryParams(address: string, maxSignatures: number) {
  return [
    address,
    {
      limit: maxSignatures,
      transactionDetails: "signatures",
    },
  ];
}

export function classifySolamiListingFailure(error: unknown): HistoryFallbackReason {
  const kind = classifyRpcError(error);
  if (kind === "http-4xx" || kind === "http-5xx") return "solami-http-error";
  if (kind === "empty") return "solami-empty";
  if (kind === "validation") return "solami-unparseable";
  return "solami-error";
}

export type SolamiListResult =
  | { ok: true; items: ParsedHistoryTx[] }
  | { ok: false; reason: HistoryFallbackReason };

/** Solami-only custom method. Empty / HTTP / parse failures are classified, not thrown. */
export async function listSolamiAddressSignatures(
  customRpc: CustomRpcCall,
  address: string,
  maxSignatures: number,
): Promise<SolamiListResult> {
  try {
    const raw = await customRpc("getTransactionsForAddress", solamiHistoryParams(address, maxSignatures));
    const { rows } = unwrapTransactionsForAddressResult(raw);
    if (!rows.length) return { ok: false, reason: "solami-empty" };
    const parsed = rows.map(parseHistoryTxCandidate).filter((item): item is ParsedHistoryTx => item !== null);
    if (parsed.length === 0) return { ok: false, reason: "solami-unparseable" };
    return { ok: true, items: parsed };
  } catch (error) {
    return { ok: false, reason: classifySolamiListingFailure(error) };
  }
}

export function toHistorySignature(item: ParsedHistoryTx): HistorySignature {
  return {
    signature: item.signature,
    slot: item.slot,
    blockTime: item.blockTime,
    err: item.err,
  };
}
