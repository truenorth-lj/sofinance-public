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
 *
 * Own-pool quotes (Raydium CLMM direct) also prefetch the unconstrained fallback
 * for the same pair/amount so the next round does not 409 again if own-pool has
 * no route. Quotes are indexed by URL as well as id so a prefetch is reused when
 * the server later names that request. If the same mint pair keeps coming back
 * with a new amount (sizing did not settle), we stop instead of burning the
 * remaining rounds.
 */
export const JUPITER_BROWSER_ORIGIN = "https://api.jup.ag";
export const JUPITER_RELAY_NEEDED_CODE = "jupiter_relay_needed";
/** Responses older than this are re-fetched (quotes are short-lived). */
export const RELAY_RESPONSE_MAX_AGE_MS = 30_000;
export const MAX_RELAY_ROUNDS = 8;
/** Consecutive 409s that only re-quote an already-seen pair at a new amount. */
export const RELAY_AMOUNT_CHURN_LIMIT = 3;
export const RELAY_DID_NOT_SETTLE_MESSAGE =
  "Quote did not settle. Try a smaller amount, a wider range, or refresh the quote.";
const MAX_STORED = 40;
const MAX_RATE_LIMIT_WAIT_MS = 12_000;
const RATE_LIMIT_RETRIES = 2;
const RESET_JITTER_MS = 250;
const RAYDIUM_CLMM_DEX = "Raydium CLMM";
const PREFETCH_MAX_ACCOUNTS = "48";

export type RelayNeed = { id: string; method: "GET" | "POST"; url: string; body?: unknown };
type StoredResponse = { status: number; body: unknown; retryAfterMs: number | null; at: number };
/** Per-flow state: fetched Jupiter responses plus the server's sizing hints. */
export type JupiterRelayStore = {
  responses: Map<string, StoredResponse>;
  byUrl: Map<string, StoredResponse>;
  hints: Record<string, string>;
};
const HINTS_HEADER = "x-jupiter-relay-hints";
const MAX_HINTS = 16;

export function createJupiterRelayStore(): JupiterRelayStore {
  return { responses: new Map(), byUrl: new Map(), hints: {} };
}

function keepHints(store: JupiterRelayStore, hints: unknown) {
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) return;
  const merged = { ...store.hints, ...(hints as Record<string, string>) };
  store.hints = Object.fromEntries(Object.entries(merged).filter(([, value]) => typeof value === "string").slice(-MAX_HINTS));
}

/** Counters for diagnostics/verification (also exposed as `window.__sofiJupiter`). */
export const jupiterBrowserStats = {
  calls: 0, quotes: 0, swapInstructions: 0, rateLimited: 0, waitedMs: 0, reused: 0, rounds: 0, fallbacks: 0, churnStops: 0,
};

const gate = { remaining: undefined as number | undefined, resetAtMs: 0, blockedUntil: 0 };
let queue: Promise<unknown> = Promise.resolve();

export function resetJupiterBrowserGate() {
  gate.remaining = undefined; gate.resetAtMs = 0; gate.blockedUntil = 0; queue = Promise.resolve();
  Object.assign(jupiterBrowserStats, {
    calls: 0, quotes: 0, swapInstructions: 0, rateLimited: 0, waitedMs: 0, reused: 0, rounds: 0, fallbacks: 0, churnStops: 0,
  });
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

function prune(store: JupiterRelayStore, now = Date.now()) {
  const stale = (entry: StoredResponse) => now - entry.at > RELAY_RESPONSE_MAX_AGE_MS;
  for (const [id, entry] of store.responses) if (stale(entry)) store.responses.delete(id);
  for (const [key, entry] of store.byUrl) if (stale(entry)) store.byUrl.delete(key);
  while (store.responses.size > MAX_STORED) store.responses.delete(store.responses.keys().next().value!);
}

function urlIndexKey(need: Pick<RelayNeed, "method" | "url">) {
  return need.method === "GET" ? `GET:${need.url}` : "";
}

function freshEntry(entry: StoredResponse | undefined, now = Date.now()) {
  return entry && now - entry.at <= RELAY_RESPONSE_MAX_AGE_MS ? entry : undefined;
}

function storedFor(store: JupiterRelayStore, need: RelayNeed) {
  const byId = freshEntry(store.responses.get(need.id));
  if (byId) return byId;
  const key = urlIndexKey(need);
  const byUrl = key ? freshEntry(store.byUrl.get(key)) : undefined;
  if (byUrl && need.id) store.responses.set(need.id, byUrl);
  return byUrl;
}

function remember(store: JupiterRelayStore, need: RelayNeed, entry: StoredResponse) {
  if (need.id) store.responses.set(need.id, entry);
  const key = urlIndexKey(need);
  if (key) store.byUrl.set(key, entry);
}

/** Pair identity for a Jupiter quote URL, ignoring the amount (used to detect sizing churn). */
export function quotePairKey(url: string): string | null {
  if (!url.startsWith("/swap/v1/quote")) return null;
  const params = new URLSearchParams(url.split("?")[1] ?? "");
  const inputMint = params.get("inputMint");
  const outputMint = params.get("outputMint");
  if (!inputMint || !outputMint) return null;
  return [inputMint, outputMint, params.get("maxAccounts") ?? "", params.get("onlyDirectRoutes") ?? "", params.get("dexes") ?? ""].join(":");
}

function isAmountChurn(need: RelayNeed, store: JupiterRelayStore) {
  const pair = quotePairKey(need.url);
  if (!pair || need.method !== "GET") return false;
  for (const key of store.byUrl.keys()) {
    const url = key.slice("GET:".length);
    if (url !== need.url && quotePairKey(url) === pair) return true;
  }
  return false;
}

/**
 * Own-pool quotes try Raydium CLMM direct first, then the unconstrained route.
 * Prefetch the fallback in the same browser round so a no-route own-pool answer
 * does not cost another 409.
 */
export function companionQuoteNeeds(need: RelayNeed): RelayNeed[] {
  if (need.method !== "GET" || !need.url.startsWith("/swap/v1/quote")) return [];
  const [path, query = ""] = need.url.split("?");
  const params = new URLSearchParams(query);
  if (params.get("onlyDirectRoutes") !== "true" || params.get("dexes") !== RAYDIUM_CLMM_DEX) return [];
  const ordered = new URLSearchParams();
  for (const key of ["inputMint", "outputMint", "amount", "slippageBps", "instructionVersion", "platformFeeBps"]) {
    const value = params.get(key);
    if (value !== null) ordered.set(key, value);
  }
  ordered.set("maxAccounts", PREFETCH_MAX_ACCOUNTS);
  return [{ id: "", method: "GET", url: `${path}?${ordered.toString()}` }];
}

export function expandRelayNeeds(needs: readonly RelayNeed[]): RelayNeed[] {
  const seen = new Set<string>();
  const out: RelayNeed[] = [];
  for (const need of [...needs, ...needs.flatMap(companionQuoteNeeds)]) {
    const key = `${need.method}:${need.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(need);
  }
  return out;
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
  let churnRounds = 0;
  for (let round = 0; round < MAX_RELAY_ROUNDS; round++) {
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
    const listed = data.needs.filter((need): need is RelayNeed =>
      !!need && typeof need === "object" && typeof need.id === "string" && (need.method === "GET" || need.method === "POST") && typeof need.url === "string");
    if (listed.length === 0) return response;
    const freshListed = listed.filter((need) => !storedFor(store, need));
    const churning = freshListed.length > 0 && freshListed.every((need) => isAmountChurn(need, store));
    churnRounds = churning ? churnRounds + 1 : 0;
    if (churnRounds >= RELAY_AMOUNT_CHURN_LIMIT) {
      jupiterBrowserStats.churnStops++;
      throw new Error(RELAY_DID_NOT_SETTLE_MESSAGE);
    }
    try {
      for (const need of expandRelayNeeds(listed)) {
        if (storedFor(store, need)) { jupiterBrowserStats.reused++; continue; }
        remember(store, need, { ...await fetchNeed(need, signal), at: Date.now() });
      }
    } catch (error) {
      if (!(error instanceof JupiterBrowserUnavailable)) throw error;
      jupiterBrowserStats.fallbacks++;
      return post(payload);
    }
  }
  throw new Error(RELAY_DID_NOT_SETTLE_MESSAGE);
}

if (typeof window !== "undefined") {
  (window as unknown as { __sofiJupiter?: typeof jupiterBrowserStats }).__sofiJupiter = jupiterBrowserStats;
}
