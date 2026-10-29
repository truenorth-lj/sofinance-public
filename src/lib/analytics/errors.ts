import { scrubSensitiveText } from "../sentry/scrub";

export const OPEN_ERROR_CLASSES = [
  "user_rejected",
  "expired",
  "insufficient_funds",
  "simulation_failed",
  "authorization",
  "network",
  "onchain_failed",
  "unconfirmed",
  "unknown",
] as const;

export type OpenErrorClass = (typeof OPEN_ERROR_CLASSES)[number];

/** Finer `error_reason` for open_position_failed. `error_class` stays for continuity with older events. */
export const OPEN_ERROR_REASONS = [
  "sol_input_disabled",
  "phantom_blocked",
  "wallet_error",
  "stale_quote",
  "no_route",
  "tx_too_large",
  "invalid_input",
  "local_history",
  "user_rejected",
  "expired",
  "insufficient_funds",
  "price_impact",
  "simulation_failed",
  "authorization",
  "broadcast_failed",
  "network",
  "onchain_failed",
  "unconfirmed",
  "unknown",
] as const;

export type OpenErrorReason = (typeof OPEN_ERROR_REASONS)[number];

const ERROR_MESSAGE_LIMIT = 120;
// Wallet-standard / EIP-1193 style "user rejected" code (Phantom uses it).
const USER_REJECTED_CODE = 4001;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  // Wallet adapters / providers sometimes reject with plain `{ code, message }` objects.
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function errorCode(error: unknown): number | undefined {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "number") return code;
    current = (current as { error?: unknown; cause?: unknown }).error ?? (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Coarse class only — never returns the original message (may contain addresses/keys). */
export function classifyOpenError(error: unknown): OpenErrorClass {
  const message = errorText(error).toLowerCase();
  if (errorCode(error) === USER_REJECTED_CODE) return "user_rejected";
  if (/user rejected|rejected the request|cancelled|canceled|denied/.test(message)) return "user_rejected";
  if (/blockhash expired|quote expired|sign token has expired|expired without landing/.test(message)) return "expired";
  if (/insufficient|not enough|no eligible/.test(message)) return "insufficient_funds";
  if (/simulation|slippage|price impact|price slippage/.test(message)) return "simulation_failed";
  if (/permit|authorization|signature mismatch|payer mismatch|modified transaction|required instruction/.test(message)) return "authorization";
  if (/timeout|network|failed to fetch|429|socket hang up|unavailable/.test(message)) return "network";
  if (/failed on-chain/.test(message)) return "onchain_failed";
  if (/unconfirmed|manual verification|unable to verify/.test(message)) return "unconfirmed";
  return "unknown";
}

/**
 * Reason category. Phantom's "Request blocked" screen usually surfaces to the dApp as a plain
 * user rejection (code 4001), so `phantom_blocked` only fires when the wallet says so; pair
 * `user_rejected` with `input_kind: "native"` to estimate blocks on the old single-tx SOL open.
 */
export function classifyOpenErrorReason(error: unknown): OpenErrorReason {
  const message = errorText(error).toLowerCase();
  if (/sol deposits are temporarily unavailable|native sol input is (?:temporarily )?disabled/.test(message)) return "sol_input_disabled";
  if (/request blocked|malicious|blocked by (?:the )?wallet|flagged as (?:unsafe|dangerous)/.test(message)) return "phantom_blocked";
  const coarse = classifyOpenError(error);
  if (coarse === "user_rejected" || coarse === "expired" || coarse === "insufficient_funds") return coarse;
  if (/price impact|large for this pool|cross(?:es|ing)? (?:a )?tick|cross-tick/.test(message)) return "price_impact";
  if (coarse === "simulation_failed" || coarse === "authorization") return coarse;
  if (/no (?:available )?routes|route not found|could not find any route/.test(message)) return "no_route";
  if (/exceeds? (?:the )?1,?232 byte|transaction (?:is )?too large|encoding overruns/.test(message)) return "tx_too_large";
  if (/open-position history|open-position record|open-position transaction record/.test(message)) return "local_history";
  if (/expired or incomplete|changed since preparation|changed during signing|changed after step|quote and current input mismatch|did not converge/.test(message)) return "stale_quote";
  if (/^wallet/.test(errorName(error).toLowerCase()) || errorCode(error) === -32603 ||
    /wallet (?:did not return|returned|signature is invalid)|nft mint (?:signature|partial signature|is not a required signer)|wallet signature|missing required signatures|plugin closed|unexpected error|not connected|wallet additions/.test(message)) return "wallet_error";
  if (/^invalid |range preset|custom range requires|too small to allocate|quotes required/.test(message)) return "invalid_input";
  if (/submission failed|broadcast|send(?:ing)? (?:the )?transaction|sendtransaction|not sent/.test(message)) return "broadcast_failed";
  if (coarse === "network" || /timed out|aborted/.test(message) ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) return "network";
  return coarse;
}

/** Short, scrubbed message: no URLs, emails, addresses, signatures or credentials. */
export function sanitizeOpenErrorMessage(error: unknown): string | undefined {
  const text = errorText(error).trim();
  if (!text) return undefined;
  const scrubbed = scrubSensitiveText(text)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\b(?:0x)?[0-9a-f]{24,}\b/gi, "[hex]")
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > ERROR_MESSAGE_LIMIT ? `${scrubbed.slice(0, ERROR_MESSAGE_LIMIT - 1)}…` : scrubbed;
}

export type OpenFailureProperties = {
  error_class: OpenErrorClass;
  error_reason: OpenErrorReason;
  error_message?: string;
};

/** Properties for an open that failed before or during send (thrown error). */
export function openFailureProperties(error: unknown): OpenFailureProperties {
  const properties: OpenFailureProperties = {
    error_class: classifyOpenError(error),
    error_reason: classifyOpenErrorReason(error),
  };
  const message = sanitizeOpenErrorMessage(error);
  if (message) properties.error_message = message;
  return properties;
}

/** Properties for a sent open whose chain outcome was failed or expired. */
export function openOutcomeFailureProperties(status: "failed" | "expired"): OpenFailureProperties {
  return status === "expired"
    ? { error_class: "expired", error_reason: "expired" }
    : { error_class: "onchain_failed", error_reason: "onchain_failed" };
}
