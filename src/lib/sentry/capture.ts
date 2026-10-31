import * as Sentry from "@sentry/nextjs";
import { isJupiterUpstreamError, JupiterHttpError, JupiterUnavailableError, JUPITER_NO_ROUTE_CODE } from "@sofinance/engine/jupiter/errors";
import { RpcHttpError, RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { publicErrorCode, CompoundSendError, sanitizePublicError } from "../public-error";
import { AMOUNT_TOO_SMALL_CODE, JUPITER_CLIENT_ERROR_CODE } from "../selected-amount-error";
import { isSentryEnabled } from "./runtime";
import { pathnameFromUrl, routeFromRequest, routeFromTransaction } from "./route";
import { logSafeError } from "../safe-error-log";

export function sentryErrorClass(error: unknown): string {
  if (error instanceof CompoundSendError && error.cause !== undefined) {
    return sentryErrorClass(error.cause);
  }
  if (error instanceof JupiterUnavailableError) return "JupiterUnavailableError";
  if (error instanceof JupiterHttpError) return "JupiterHttpError";
  if (error instanceof RpcUnavailableError) return "RpcUnavailableError";
  if (error instanceof RpcHttpError) return "RpcHttpError";
  if (error instanceof Error && error.name) return error.name;
  return "unknown";
}

export function isUserRejectedError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /user rejected|rejected the request|wallet.*reject|cancelled by user|user cancel/i.test(text);
}

const USER_FACING_SELECTED_CODES = new Set([
  JUPITER_NO_ROUTE_CODE,
  AMOUNT_TOO_SMALL_CODE,
  JUPITER_CLIENT_ERROR_CODE,
]);

/** Coded 4xx user-facing selected errors — never report these. */
export function isUserFacingSelectedError(error: unknown): boolean {
  if (error instanceof CompoundSendError && error.cause !== undefined) {
    return isUserFacingSelectedError(error.cause);
  }
  const code = publicErrorCode(error);
  return code !== undefined && USER_FACING_SELECTED_CODES.has(code);
}

export function isUpstreamAvailabilityError(error: unknown): boolean {
  if (error instanceof CompoundSendError && error.cause !== undefined) {
    return isUpstreamAvailabilityError(error.cause);
  }
  if (isUserFacingSelectedError(error)) return false;
  if (error instanceof JupiterUnavailableError || isJupiterUpstreamError(error)) return true;
  if (error instanceof RpcUnavailableError) return true;
  if (error instanceof RpcHttpError) return error.status === 429 || error.status >= 500;
  const code = publicErrorCode(error);
  return code === "jupiter_unavailable" || code === "rpc_unavailable" || code === "jupiter_rate_limited";
}

/** 5xx / Jupiter+RPC upstream only. Never validation 4xx or user-rejected. */
export function shouldCaptureApiError(error: unknown, status = 500): boolean {
  if (isUserRejectedError(error)) return false;
  if (isUserFacingSelectedError(error)) return false;
  if (isUpstreamAvailabilityError(error)) return true;
  return status >= 500;
}

/**
 * Transaction routes (broadcast/status): also report 4xx failures, because an
 * expired, unsent or stuck transaction is an operational problem even when the request
 * itself was valid. Still skips user rejections, coded user-facing errors and malformed input.
 */
export function shouldCaptureTransactionError(error: unknown, status = 500): boolean {
  if (shouldCaptureApiError(error, status)) return true;
  if (status < 400 || isUserRejectedError(error) || isUserFacingSelectedError(error)) return false;
  const source = error instanceof CompoundSendError && error.cause !== undefined ? error.cause : error;
  const message = source instanceof Error ? source.message : String(source);
  return !/^Invalid\b/i.test(message.trim());
}

function routeFromActiveSentryContext(): string | undefined {
  try {
    const scope = Sentry.getCurrentScope();
    const transaction = scope.getScopeData().transactionName;
    const fromScope = routeFromTransaction(transaction);
    if (fromScope) return fromScope;
    const span = Sentry.getActiveSpan();
    if (!span) return undefined;
    const json = Sentry.spanToJSON(span);
    return routeFromTransaction(json.name)
      ?? pathnameFromUrl(typeof json.attributes["http.route"] === "string" ? json.attributes["http.route"] : undefined)
      ?? pathnameFromUrl(typeof json.attributes["http.target"] === "string" ? json.attributes["http.target"] : undefined);
  } catch {
    return undefined;
  }
}

export function resolveApiRoute(options: {
  route?: string;
  request?: { url: string };
} = {}): string | undefined {
  return options.route ?? routeFromRequest(options.request) ?? routeFromActiveSentryContext();
}

export function captureApiRouteError(
  error: unknown,
  options: { route?: string; request?: { url: string }; fallback?: string; status?: number; quotePath?: string;
    transaction?: boolean; sent?: boolean } = {},
): void {
  try {
    if (!isSentryEnabled()) return;
    const status = options.status ?? 500;
    if (!(options.transaction ? shouldCaptureTransactionError(error, status) : shouldCaptureApiError(error, status))) return;
    const route = resolveApiRoute(options);
    Sentry.withScope((scope) => {
      if (route) scope.setTag("route", route);
      if (options.transaction && status < 500) scope.setLevel("warning");
      if (options.transaction) scope.setTag("tx_sent", options.sent === false ? "no" : "unknown");
      scope.setTag("error_class", sentryErrorClass(error));
      if (options.quotePath) scope.setTag("quote_path", options.quotePath);
      scope.setExtra("public_message", sanitizePublicError(error, options.fallback ?? "API route error"));
      Sentry.captureException(error);
    });
  } catch {
    // Monitoring must never fail the request.
  }
}

export type QuoteSettleFailureExtras = {
  pair?: string;
  amount?: string;
  rangeWidth?: string;
  rounds?: number;
  quotePath?: string;
};

/** Phantom-modified tx failed the cheap sanity check. Program ids only — no wallet, no secrets. */
export function captureWalletReturnedTxFailure(error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Wallet removed or changed a required instruction/.test(message)) return;
    logSafeError(message, error);
    if (!isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setTag("error_class", "wallet_returned_tx_mismatch");
      scope.setExtra("diagnostic", message);
      Sentry.captureException(error instanceof Error ? error : new Error(message));
    });
  } catch {
    // Monitoring must never fail the flow.
  }
}

/** Open-position quote sizing never settled. Pair/amount/range only — no wallet, no secrets. */
export function captureQuoteSettleFailure(error: unknown, extras: QuoteSettleFailureExtras = {}): void {
  try {
    if (!isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setTag("error_class", sentryErrorClass(error));
      scope.setTag("quote_settle", "did_not_settle");
      if (extras.quotePath) scope.setTag("quote_path", extras.quotePath);
      if (extras.pair) scope.setExtra("pair", extras.pair);
      if (extras.amount) scope.setExtra("amount", extras.amount);
      if (extras.rangeWidth) scope.setExtra("range_width", extras.rangeWidth);
      if (extras.rounds !== undefined) scope.setExtra("rounds", extras.rounds);
      Sentry.captureException(error);
    });
  } catch {
    // Monitoring must never fail the request.
  }
}

/**
 * Robinhood Chain registry discovery found something to review (a non-allowlisted pool, a beacon change).
 * Info level: nothing is broken and nothing is shown to users. Addresses and pool ids only.
 */
export function captureRhcDiscoveryFindings(findings: readonly string[]): void {
  try {
    if (!findings.length || !isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setLevel("info");
      scope.setTag("rhc_discovery", "findings");
      scope.setExtra("findings", findings.slice(0, 50));
      Sentry.captureMessage(`RHC discovery: ${findings.length} finding(s) to review`, "info");
    });
  } catch {
    // Monitoring must never fail the cron.
  }
}
