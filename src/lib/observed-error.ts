import { logSafeError } from "./safe-error-log";
import { RwaStoreError } from "./rwa-store-types";
import { PositionHistoryStoreError } from "./position-history-store-types";
import { StockEntryPriceStoreError } from "./stock-entry-price-store-types";

/** PostgreSQL SQLSTATE: two-character class plus three-character subclass. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** libuv/node errno names (`ECONNREFUSED`). Not a store code and not a SQLSTATE. */
const NODE_ERRNO = /^E[A-Z][A-Z0-9]*$/;
const STORE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
/** Connection strings the HTTP scrubber does not treat as URLs, plus the env name itself. */
const CONNECTION_SECRET = /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/|DATABASE_URL|[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s@]*@/i;

export const GATEWAY_TIMEOUT_CODE = "GATEWAY_TIMEOUT";
export const GATEWAY_PARSE_CODE = "GATEWAY_PARSE";

export type ObservedErrorFields = {
  name: string;
  /** PostgreSQL SQLSTATE when the error or a cause carries one. */
  pgCode?: string;
  /** Upstream HTTP status when the error or a cause carries one. */
  httpStatus?: number;
  /** Stable store/gateway code. Never a SQLSTATE or a node errno. */
  storeCode?: string;
};

export function containsCredential(text: string): boolean {
  return CONNECTION_SECRET.test(text);
}

function stringField(value: unknown, max = 64): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function safeName(value: unknown): string | undefined {
  const name = stringField(value, 81);
  return name && SAFE_NAME.test(name) && !containsCredential(name) ? name : undefined;
}

function readCause(value: object): unknown {
  try {
    return (value as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

/** Name, SQLSTATE, HTTP status, and store code. No error message: that text can carry a connection string. */
export function classifyObservedError(error: unknown): ObservedErrorFields {
  let name = "unknown";
  let pgCode: string | undefined;
  let httpStatus: number | undefined;
  let storeCode: string | undefined;
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (depth === 0) name = safeName((current as { name?: unknown }).name) ?? (current instanceof Error ? "Error" : "unknown");
    const explicitPg = stringField((current as { pgCode?: unknown }).pgCode, 5);
    if (explicitPg && SQLSTATE.test(explicitPg)) pgCode ??= explicitPg;
    const code = stringField((current as { code?: unknown }).code);
    if (code && SQLSTATE.test(code)) pgCode ??= code;
    else if (code && !NODE_ERRNO.test(code) && STORE_CODE.test(code)) storeCode ??= code;
    const status = (current as { status?: unknown }).status ?? (current as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) httpStatus ??= status;
    current = readCause(current);
  }
  return {
    name,
    ...(pgCode ? { pgCode } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(storeCode ? { storeCode } : {}),
  };
}

export function isLeaseLost(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if ((current as { code?: unknown }).code === "LEASE_LOST") return true;
    current = readCause(current);
  }
  return false;
}

/** AbortSignal.timeout rejects with TimeoutError; a caller abort is AbortError. JSON.parse is SyntaxError. */
export function transportFailureCode(error: unknown): typeof GATEWAY_TIMEOUT_CODE | typeof GATEWAY_PARSE_CODE | undefined {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const name = (current as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return GATEWAY_TIMEOUT_CODE;
    if (current instanceof SyntaxError) return GATEWAY_PARSE_CODE;
    current = readCause(current);
  }
  return undefined;
}

export function stableErrorCode(code: unknown, fallback: string): string {
  if (typeof code !== "string" || !STORE_CODE.test(code) || containsCredential(code)) return fallback;
  return code;
}

export function logObservedError(
  label: string,
  error: unknown,
  context: { route?: string; job?: string; storeCode?: string } = {},
): ObservedErrorFields {
  const fields = classifyObservedError(error);
  const storeCode = context.storeCode ?? fields.storeCode;
  const payload = {
    name: fields.name,
    ...(fields.pgCode ? { pgCode: fields.pgCode } : {}),
    ...(fields.httpStatus !== undefined ? { httpStatus: fields.httpStatus } : {}),
    ...(storeCode ? { storeCode } : {}),
    ...(context.route ? { route: context.route } : {}),
    ...(context.job ? { job: context.job } : {}),
  };
  logSafeError(label, payload);
  return { ...fields, ...(storeCode ? { storeCode } : {}) };
}

/** Private data-gateway catch: stable code in the HTTP body, classification only in logs. */
export function dataServiceFailure(error: unknown): { status: number; code: string } {
  if (error instanceof RwaStoreError || error instanceof PositionHistoryStoreError || error instanceof StockEntryPriceStoreError) {
    return { status: error.code === "LEASE_LOST" ? 409 : 503, code: error.code };
  }
  return { status: 503, code: transportFailureCode(error) ?? "RWA_STORE_UNAVAILABLE" };
}
