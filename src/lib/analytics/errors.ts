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

/** Coarse class only — never returns the original message (may contain addresses/keys). */
export function classifyOpenError(error: unknown): OpenErrorClass {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const message = text.toLowerCase();
  if (/user rejected|rejected the request|cancelled|canceled|denied/.test(message)) return "user_rejected";
  if (/blockhash expired|quote expired|sign token has expired|expired without landing/.test(message)) return "expired";
  if (/insufficient|not enough|no eligible/.test(message)) return "insufficient_funds";
  if (/simulation|slippage|price impact|price slippage/.test(message)) return "simulation_failed";
  if (/permit|authorization|signature mismatch|payer mismatch|modified transaction/.test(message)) return "authorization";
  if (/timeout|network|failed to fetch|429|socket hang up|unavailable/.test(message)) return "network";
  if (/failed on-chain/.test(message)) return "onchain_failed";
  if (/unconfirmed|manual verification|unable to verify/.test(message)) return "unconfirmed";
  return "unknown";
}
