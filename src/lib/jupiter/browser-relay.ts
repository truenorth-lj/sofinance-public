/**
 * Browser-side Jupiter quoting. Quotes and swap-instructions are fetched keyless
 * from `api.jup.ag` by the user's browser (CORS allows our origin and exposes the
 * x-ratelimit-* headers), so Jupiter traffic counts against each user's own IP
 * quota (~5 requests / 10 s) instead of the shared server key.
 *
 * Protocol (see `withJupiterRelay` on the server): POST the normal body plus
 * `jupiterRelay.responses`; on 409 `jupiter_relay_needed`, fetch the listed
 * requests here (paced, one at a time), add them and POST again. Fetched answers
 * are kept briefly per flow so the preview's quotes are replayed by prepare.
 */
export const JUPITER_BROWSER_ORIGIN = "https://api.jup.ag";
export const JUPITER_RELAY_NEEDED_CODE = "jupiter_relay_needed";
/** Responses older than this are re-fetched (quotes are short-lived). */
export const RELAY_RESPONSE_MAX_AGE_MS = 30_000;
const MAX_ROUNDS = 8;
const MAX_STORED = 40;
const MAX_RATE_LIMIT_WAIT_MS = 12_000;
const RATE_LIMIT_RETRIES = 2;
const RESET_JITTER_MS = 250;

export type RelayNeed = { id: string; method: "GET" | "POST"; url: string; body?: unknown };
type StoredResponse = { status: number; body: unknown; retryAfterMs: number | null; at: number };
/** Per-flow state: fetched Jupiter responses plus the server's sizing hints. */
export type JupiterRelayStore = { responses: Map<string, StoredResponse>; hints: Record<string, string> };
const HINTS_HEADER = "x-jupiter-relay-hints";
const MAX_HINTS = 16;

export function createJupiterRelayStore(): JupiterRelayStore {
  return { responses: new Map(), hints: {} };
}

function keepHints(store: JupiterRelayStore, hints: unknown) {
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) return;
  const merged = { ...store.hints, ...(hints as Record<string, string>) };
  store.hints = Object.fromEntries(Object.entries(merged).filter(([, value]) => typeof value === "string").slice(-MAX_HINTS));
}

/** Counters for diagnostics/verification (also exposed as `window.__sofiJupiter`). */
export const jupiterBrowserStats = { calls: 0, quotes: 0, swapInstructions: 0, rateLimited: 0, waitedMs: 0, reused: 0, rounds: 0, fallbacks: 0 };

const gate = { remaining: undefined as number | undefined, resetAtMs: 0, blockedUntil: 0 };
let queue: Promise<unknown> = Promise.resolve();

export function resetJupiterBrowserGate() {
  gate.remaining = undefined; gate.resetAtMs = 0; gate.blockedUntil = 0; queue = Promise.resolve();
  Object.assign(jupiterBrowserStats, { calls: 0, quotes: 0, swapInstructions: 0, rateLimited: 0, waitedMs: 0, reused: 0, rounds: 0, fallbacks: 0 });
}

export function jupiterRelayEnabled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage?.getItem("sofiJupiterRelay") !== "off";
  } catch {
    return typeof window !== "undefined";
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function headerNumber(response: Response, name: string) {
  const text = response.headers.get(name)?.trim();
  const value = text ? Number(text) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function noteRateHeaders(response: Response) {
  const remaining = headerNumber(response, "x-ratelimit-remaining");
  const reset = headerNumber(response, "x-ratelimit-reset");
  if (remaining !== undefined) gate.remaining = remaining;
  // Jupiter sends the window reset as epoch seconds.
  if (reset !== undefined) gate.resetAtMs = reset > 1e12 ? reset : reset * 1000;
}

function rateLimitWaitMs(response: Response, now = Date.now()) {
  const retryAfter = headerNumber(response, "retry-after");
  if (retryAfter !== undefined) return Math.min(MAX_RATE_LIMIT_WAIT_MS, retryAfter * 1000 + RESET_JITTER_MS);
  if (gate.resetAtMs > now) return Math.min(MAX_RATE_LIMIT_WAIT_MS, gate.resetAtMs - now + RESET_JITTER_MS);
  return 2_000;
}

async function waitForGate(signal?: AbortSignal) {
  const now = Date.now();
  let until = gate.blockedUntil;
  if (gate.remaining !== undefined && gate.remaining <= 0 && gate.resetAtMs > now) until = Math.max(until, gate.resetAtMs + RESET_JITTER_MS);
  if (until > now) {
    const wait = Math.min(MAX_RATE_LIMIT_WAIT_MS, until - now);
    jupiterBrowserStats.waitedMs += wait;
    await sleep(wait, signal);
  }
}

class JupiterBrowserUnavailable extends Error {}

async function fetchNeedOnce(need: RelayNeed, signal?: AbortSignal): Promise<Omit<StoredResponse, "at">> {
  for (let attempt = 0; ; attempt++) {
    await waitForGate(signal);
    let response: Response;
    try {
      response = await fetch(`${JUPITER_BROWSER_ORIGIN}${need.url}`, {
        method: need.method,
        headers: need.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: need.body !== undefined ? JSON.stringify(need.body) : undefined,
        cache: "no-store", credentials: "omit", signal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // CORS rejection or network failure: let the caller fall back to the server path.
      throw new JupiterBrowserUnavailable(error instanceof Error ? error.message : "Jupiter unreachable");
    }
    jupiterBrowserStats.calls++;
    if (need.url.startsWith("/swap/v1/swap-instructions")) jupiterBrowserStats.swapInstructions++;
    else jupiterBrowserStats.quotes++;
    noteRateHeaders(response);
    if (response.status === 429) {
      jupiterBrowserStats.rateLimited++;
      const wait = rateLimitWaitMs(response);
      gate.blockedUntil = Date.now() + wait;
      if (attempt < RATE_LIMIT_RETRIES) continue;
      return { status: 429, body: { error: "Jupiter rate limit" }, retryAfterMs: wait };
    }
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body, retryAfterMs: null };
  }
}

/** One Jupiter request at a time per page: the keyless quota is per IP. */
function fetchNeed(need: RelayNeed, signal?: AbortSignal) {
  const run = queue.then(() => fetchNeedOnce(need, signal));
  queue = run.catch(() => undefined);
  return run;
}

function prune({ responses }: JupiterRelayStore, now = Date.now()) {
  for (const [id, entry] of responses) if (now - entry.at > RELAY_RESPONSE_MAX_AGE_MS) responses.delete(id);
  while (responses.size > MAX_STORED) responses.delete(responses.keys().next().value!);
}

function relayPayload(store: JupiterRelayStore) {
  return {
    responses: Object.fromEntries([...store.responses].map(([id, { status, body, retryAfterMs }]) => [id, { status, body, retryAfterMs }])),
    hints: store.hints,
  };
}

/**
 * POSTs `payload` to one of our quote/prepare routes, serving every Jupiter call
 * the server needs from this browser. Returns the route's final Response.
 * Falls back to the server-keyed path if Jupiter is unreachable from the browser.
 */
export async function postWithJupiterRelay(url: string, payload: Record<string, unknown>,
  options: { store: JupiterRelayStore; signal?: AbortSignal }): Promise<Response> {
  const post = (body: Record<string, unknown>) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal: options.signal });
  if (!jupiterRelayEnabled()) return post(payload);
  const { store, signal } = options;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    prune(store);
    jupiterBrowserStats.rounds++;
    const response = await post({ ...payload, jupiterRelay: relayPayload(store) });
    if (response.status !== 409) {
      try { keepHints(store, JSON.parse(response.headers.get(HINTS_HEADER) ?? "null")); } catch { /* ignore malformed hints */ }
      return response;
    }
    const data = await response.clone().json().catch(() => null) as { code?: string; needs?: RelayNeed[]; hints?: unknown } | null;
    if (data?.code !== JUPITER_RELAY_NEEDED_CODE || !Array.isArray(data.needs) || data.needs.length === 0) return response;
    keepHints(store, data.hints);
    try {
      for (const need of data.needs) {
        const cached = store.responses.get(need.id);
        if (cached && Date.now() - cached.at <= RELAY_RESPONSE_MAX_AGE_MS) { jupiterBrowserStats.reused++; continue; }
        store.responses.set(need.id, { ...await fetchNeed(need, signal), at: Date.now() });
      }
    } catch (error) {
      if (!(error instanceof JupiterBrowserUnavailable)) throw error;
      jupiterBrowserStats.fallbacks++;
      return post(payload);
    }
  }
  throw new Error("Quote is still changing, please retry");
}

if (typeof window !== "undefined") {
  (window as unknown as { __sofiJupiter?: typeof jupiterBrowserStats }).__sofiJupiter = jupiterBrowserStats;
}
