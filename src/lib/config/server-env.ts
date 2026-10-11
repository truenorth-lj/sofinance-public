// The ONE place that reads server secrets from the environment (ratchet: lib/env-reads.guard.test.ts).
// Semantics are exactly what the call sites had inline, nothing is trimmed or normalised:
//   getJupiterApiKey()  === process.env.JUPITER_API_KEY            (undefined when unset, "" and "  " pass through)
//   getSigningSecret()  === process.env.JUPITER_API_KEY || ""      (never undefined; "" when unset or empty)
// The env var is read on every call (never cached at import time) so tests can stub it per test and a
// rotated key is seen immediately. No new env var: the signing secret IS the Jupiter API key today
// (rotating one rotates the other; review item PR-16 will split them later).

/** Jupiter portal API key, or undefined when the variable is not set. */
export function getJupiterApiKey(): string | undefined {
  return process.env.JUPITER_API_KEY;
}

/** HMAC secret for permits, MCP tokens and sign tokens. Empty string when not configured. */
export function getSigningSecret(): string {
  return getJupiterApiKey() || "";
}
