import * as Sentry from "@sentry/nextjs";
import { isJupiterUpstreamError, JupiterHttpError, JupiterUnavailableError, JUPITER_NO_ROUTE_CODE } from "@sofinance/engine/jupiter/errors";
import { isMinContextSlotError, RpcHttpError, RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { RPC_BEHIND_CODE } from "@sofinance/engine/rpc/context-slot";
import { isWalletRejection } from "@/lib/tx-pipeline/errors";
import { classifyObservedError } from "../observed-error";
import { exceptionForCapture, messageIfSanitized } from "../refresh-monitoring";
import { publicErrorCode, CompoundSendError } from "../public-error";
import { AMOUNT_TOO_SMALL_CODE, JUPITER_CLIENT_ERROR_CODE, SMALL_LEG_MOVES_PRICE_CODE } from "../selected-amount-error";
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

/**
 * Same classifier as the UI: only an explicit wallet rejection (`isWalletRejection`, codes 4001 / 5000
 * or rejection wording with no other code) is treated as a user cancel and not reported. A Phantom
 * code-400 "rejected by user" after a broadcast is not a rejection.
 */
export function isUserRejectedError(error: unknown): boolean {
  return isWalletRejection(error);
}

const USER_FACING_SELECTED_CODES = new Set([
  JUPITER_NO_ROUTE_CODE,
  AMOUNT_TOO_SMALL_CODE,
  JUPITER_CLIENT_ERROR_CODE,
  SMALL_LEG_MOVES_PRICE_CODE,
]);

/** Coded 4xx user-facing selected errors — never report these. */
export function isUserFacingSelectedError(error: unknown): boolean {
  if (error instanceof CompoundSendError && error.cause !== undefined) {
    return isUserFacingSelectedError(error.cause);
  }
  const code = publicErrorCode(error);
  return code !== undefined && USER_FACING_SELECTED_CODES.has(code);
}

function isUpstreamAvailabilityError(error: unknown): boolean {
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

/**
 * Our RPC node lagged the slot we had just read (JSON-RPC -32016), even after the automatic retries. Transient
 * infrastructure, not a user error and not a code bug: still reported so a spike is visible, but at warning level.
 */
export function isRpcBehindError(error: unknown): boolean {
  if (error instanceof CompoundSendError && error.cause !== undefined) return isRpcBehindError(error.cause);
  return publicErrorCode(error) === RPC_BEHIND_CODE || isMinContextSlotError(error);
}

/** 5xx / Jupiter+RPC upstream only. Never validation 4xx or user-rejected. */
export function shouldCaptureApiError(error: unknown, status = 500): boolean {
  if (isUserRejectedError(error)) return false;
  if (isUserFacingSelectedError(error)) return false;
  if (isUpstreamAvailabilityError(error)) return true;
  return status >= 500;
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
    transaction?: boolean; sent?: boolean; job?: string } = {},
): void {
  try {
    if (!isSentryEnabled()) return;
    const status = options.status ?? 500;
    // Ordinary 4xx (bad input, refused relay, rate limit) never reach Sentry, so abuse cannot burn the quota.
    if (!shouldCaptureApiError(error, status)) return;
    const route = resolveApiRoute(options);
    const fallback = options.fallback ?? "API route error";
    const fields = classifyObservedError(error);
    Sentry.withScope((scope) => {
      if (route) scope.setTag("route", route);
      if (options.job) scope.setTag("job", options.job);
      if (isRpcBehindError(error)) {
        scope.setLevel("warning");
        scope.setTag("rpc_behind", "true");
      }
      if (options.transaction) scope.setTag("tx_sent", options.sent === false ? "no" : "unknown");
      scope.setTag("error_class", sentryErrorClass(error));
      scope.setTag("error_name", fields.name);
      if (fields.pgCode) scope.setTag("pg_code", fields.pgCode);
      if (fields.httpStatus !== undefined) scope.setTag("http_status", String(fields.httpStatus));
      if (fields.storeCode) scope.setTag("store_code", fields.storeCode);
      // The sanitizer's text when it kept one; otherwise the fixed fallback. Never the raw message.
      scope.setExtra("public_message", messageIfSanitized(error, fallback) ?? fallback);
      Sentry.captureException(exceptionForCapture(error, fallback));
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
      // Jupiter's quotes kept moving while sizing; the user sees a retry message and nothing was sent.
      scope.setLevel("warning");
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

export type CleanupFailureExtras = { stage: string; transactions: number; sources: number; elapsedMs: number; rebroadcasts: number; detail?: string };

/**
 * The compound cleanup batch ended without closing the harvest accounts (expired unlanded, failed, refused before send,
 * needs review, or stopped before signing). Reason code and counts only: no wallet, signature or account address.
 * `detail` is a server/client message already shown to the user, capped.
 */
export function captureCleanupFailure(reason: string, extras: CleanupFailureExtras): void {
  try {
    if (!isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("flow", "compound-cleanup");
      scope.setTag("cleanup_reason", reason);
      scope.setTag("cleanup_stage", extras.stage);
      scope.setExtra("transactions", extras.transactions);
      scope.setExtra("sources", extras.sources);
      scope.setExtra("elapsed_ms", extras.elapsedMs);
      scope.setExtra("rebroadcasts", extras.rebroadcasts);
      if (extras.detail) scope.setExtra("detail", extras.detail.slice(0, 300));
      // One issue per reason, whatever the message text.
      Sentry.captureException(new Error(`Compound cleanup did not complete: ${reason}`));
    });
  } catch {
    // Monitoring must never fail the flow.
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

/**
 * A DEX operation was refused because the deployment is misconfigured (e.g. the fee policy charges but no fee wallet is
 * set). Error level: users cannot open until ops fixes the config. DEX id and operation only, no addresses or secrets.
 */
export function captureDexMisconfiguration(dexId: string, op: string, problem: string): void {
  try {
    if (!isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("dex_config", problem);
      scope.setTag("dex", dexId);
      scope.setTag("dex_op", op);
      Sentry.captureMessage(`DEX misconfigured: ${problem} (${dexId} ${op})`, "error");
    });
  } catch {
    // Monitoring must never change the response.
  }
}
