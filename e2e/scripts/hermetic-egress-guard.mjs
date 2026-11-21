// Preloaded into the hermetic `next start` only (serve-app.mjs passes `--import`); the app and production never load it.
// Any server-side fetch to real Jupiter (*.jup.ag) is refused before it leaves the process: the call rejects with a
// clear error, the server logs it, and it is appended to a ledger that the hermetic tests check (support/server-egress.ts).
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const JUPITER_HOST = /(^|\.)jup\.ag$/i;
// E2E_EGRESS_LEDGER exists only so the policy test can exercise this module in isolation (never the shared ledger).
const ledger = process.env.E2E_EGRESS_LEDGER ?? fileURLToPath(new URL("../.server-egress-blocked.jsonl", import.meta.url));
writeFileSync(`${ledger}.loaded`, String(process.pid));

const realFetch = globalThis.fetch;
globalThis.fetch = function hermeticFetch(input, init) {
  let url = null;
  try { url = new URL(input instanceof Request ? input.url : String(input)); } catch { /* relative URL: not external */ }
  if (url && JUPITER_HOST.test(url.hostname)) {
    // Host and path only: never the query string or headers (an API key could live there).
    appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), host: url.hostname, path: url.pathname })}\n`);
    const error = new Error(`[e2e hermetic] blocked server-side fetch to real Jupiter: ${url.hostname}${url.pathname}. Mock this route in the test.`);
    console.error(error.message);
    return Promise.reject(error);
  }
  return realFetch.call(this, input, init);
};
