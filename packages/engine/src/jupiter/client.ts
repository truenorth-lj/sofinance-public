import { abortError, isUserAbort } from "../rpc/errors";
import { computeBackoffMs, sleep, type RetryConfig } from "../rpc/retry";
import { withJupiterCache } from "./cache";
import {
  classifyJupiterError,
  isRetryableJupiterKind,
  JupiterHttpError,
  retryAfterFromJupiterHeaders,
} from "./errors";
import { emitJupiterLog } from "./logger";
import { jupiterHeaders, jupiterUrl } from "./urls";

export const JUPITER_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseMs: 400,
  maxDelayMs: 4_000,
  budgetMs: 12_000,
};

/** Per-request cap for a single Jupiter HTTP call (merged with any caller signal). */
export const JUPITER_FETCH_TIMEOUT_MS = 10_000;

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(JUPITER_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Best-effort price / metadata lookups. */
export const JUPITER_SOFT_RETRY: RetryConfig = {
  maxAttempts: 2,
  baseMs: 200,
  maxDelayMs: 1_000,
  budgetMs: 4_000,
};

export const JUPITER_QUOTE_TTL_MS = 8_000;
/**
 * Preview-only quotes (never signed) are shared for a few seconds: identical probe/leg quotes from a
 * recalculation, a parallel tab or the prepare's probes reuse one Jupiter call. Built swaps stay fresh.
 */
export const JUPITER_PREVIEW_QUOTE_TTL_MS = 5_000;
/** @deprecated Selected 429s now wait for the quota window when it fits the request deadline. */
export const SELECTED_RATE_LIMIT_RETRY_MS = 400;
/** Upper bound of the random spread added to a quota-window wait so waiting callers do not stampede. */
export const RATE_GATE_JITTER_MS = 250;
export const JUPITER_PRICE_TTL_MS = 10_000;
export const EXIT_JUPITER_CONCURRENCY = 2;

/** Shared by all Jupiter legs in one selected request, including compact rebuilds. */
export type JupiterRetryBudget = { deadlineAt: number; retriesLeft: number };
// Admission headroom for a retry and downstream work; the parent signal is the hard deadline.
const RETRY_HEADROOM_MS = 1_000;

let override: Partial<RetryConfig> | null = null;

/**
 * Process-wide view of Jupiter's fixed-window quota (`x-ratelimit-remaining` / `x-ratelimit-reset`).
 * Once the window is spent, callers wait for the reset (if it fits their deadline) instead of sending
 * requests that can only return 429 and still count against the key.
 */
type RateGate = { remaining: number; resetAt: number };
let rateGate: RateGate | null = null;
let gateRandom = Math.random;

export function resetJupiterRateGate(random: (() => number) | null = null): void {
  rateGate = null;
  gateRandom = random ?? Math.random;
}

export function noteJupiterRateHeaders(remaining: number | undefined, resetEpochSeconds: number | undefined): void {
  if (remaining === undefined || resetEpochSeconds === undefined) return;
  const resetAt = resetEpochSeconds * 1000;
  if (!rateGate || resetAt > rateGate.resetAt) rateGate = { remaining, resetAt };
  else if (resetAt === rateGate.resetAt) rateGate.remaining = Math.min(rateGate.remaining, remaining);
}

/** Milliseconds to wait before the next request may be sent (0 when quota remains or is unknown). */
export function jupiterRateGateWaitMs(now = Date.now()): number {
  if (!rateGate || rateGate.remaining > 0 || rateGate.resetAt <= now) return 0;
  return rateGate.resetAt - now + Math.floor(gateRandom() * RATE_GATE_JITTER_MS);
}

function reserveRateGateSlot(now = Date.now()): void {
  if (rateGate && rateGate.resetAt > now) rateGate.remaining -= 1;
}

async function waitForRateGate(options: JupiterRequestOptions, config: RetryConfig): Promise<void> {
  const wait = jupiterRateGateWaitMs();
  if (wait > 0) {
    const tooLate = options.budget
      ? Date.now() + wait + RETRY_HEADROOM_MS >= options.budget.deadlineAt
      : wait > config.budgetMs;
    if (tooLate) throw new JupiterHttpError(429, options.path, wait, "Rate limit window exhausted");
    emitJupiterLog({ path: options.path, method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
      outcome: "retry", errorKind: "rate-limit", selected: Boolean(options.budget), delayMs: wait });
    await sleep(wait, options.signal);
  }
  reserveRateGateSlot();
}

export function setJupiterRetryConfig(config: Partial<RetryConfig> | null): void {
  override = config;
}

export function jupiterRetryConfig(perCall?: Partial<RetryConfig> | null): RetryConfig {
  return { ...JUPITER_RETRY, ...override, ...perCall };
}

export type JupiterRequestOptions = {
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  apiKey?: string;
  cacheKey?: string | null;
  cacheTtlMs?: number | null;
  retry?: Partial<RetryConfig> | null;
  headers?: Record<string, string>;
  next?: { revalidate?: number };
  budget?: JupiterRetryBudget;
};

export type JupiterQuoteParams = {
  dexes?: string;
  excludeDexes?: string;
  budget?: JupiterRetryBudget;
  cacheKey?: null;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  maxAccounts?: number;
  onlyDirectRoutes?: boolean;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  apiKey?: string;
};

async function readBodyError(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    const json = JSON.parse(text) as { error?: unknown; errorCode?: unknown };
    if (typeof json.error === "string" && json.error.trim()) return json.error.slice(0, 160);
    if (typeof json.errorCode === "string" && json.errorCode.trim()) return json.errorCode.slice(0, 160);
    return null;
  } catch {
    return null;
  }
}

async function fetchJupiterOnce<T>(options: JupiterRequestOptions): Promise<T> {
  const started = performance.now();
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const url = jupiterUrl(options.path, options.query);
  const headers = jupiterHeaders(options.apiKey, {
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  });
  const response = await (options.fetcher ?? fetch)(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
    signal: requestSignal(options.signal),
    ...(options.next ? { next: options.next } : {}),
  } as RequestInit);
  const numberHeader = (name: string) => {
    const text = response.headers?.get?.(name)?.trim();
    const value = text ? Number(text) : NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  noteJupiterRateHeaders(numberHeader("x-ratelimit-remaining"), numberHeader("x-ratelimit-reset"));
  if (options.budget) {
    emitJupiterLog({ path: options.path, method, selected: true,
      outcome: response.ok ? "ok" : "error", status: response.status,
      durationMs: Math.round(performance.now() - started),
      rateLimitCurrent: numberHeader("x-ratelimit-current"),
      rateLimitRemaining: numberHeader("x-ratelimit-remaining"),
      rateLimitReset: numberHeader("x-ratelimit-reset"),
      quotePath: relayResolver?.active() ? "server_fallback" : "server",
    });
  }
  if (!response.ok) {
    const bodyError = await readBodyError(response);
    throw new JupiterHttpError(
      response.status,
      options.path,
      retryAfterFromJupiterHeaders(response.headers),
      bodyError,
    );
  }
  return response.json() as Promise<T>;
}

async function invokeJupiter<T>(options: JupiterRequestOptions): Promise<{ value: T; retries: number }> {
  const config = jupiterRetryConfig(options.retry);
  const started = Date.now();
  let retries = 0;
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      // Stay synchronous up to fetch when quota remains, so identical concurrent reads coalesce.
      if (jupiterRateGateWaitMs() > 0) await waitForRateGate(options, config);
      else reserveRateGateSlot();
      return { value: await fetchJupiterOnce<T>(options), retries };
    } catch (error) {
      lastError = error;
      if (isUserAbort(error, options.signal)) throw error;
      const kind = classifyJupiterError(error);
      const elapsed = Date.now() - started;
      const budget = options.budget;
      const canRetry = isRetryableJupiterKind(kind) && attempt < config.maxAttempts && elapsed < config.budgetMs &&
        (!budget || budget.retriesLeft > 0);
      if (!canRetry) throw error;
      // Server-directed waits (Retry-After / quota reset) are minimums. A wait that does not fit the
      // request's budget or deadline fails now: retrying earlier can only spend more of the quota on 429s.
      const serverDelay = error instanceof JupiterHttpError ? error.retryAfterMs : null;
      const delayMs = serverDelay ?? computeBackoffMs(attempt, { config });
      if (elapsed + delayMs >= config.budgetMs ||
        budget && Date.now() + delayMs + RETRY_HEADROOM_MS >= budget.deadlineAt) throw error;
      if (budget) budget.retriesLeft -= 1; // Reserve before await; parallel legs share this allowance.
      emitJupiterLog({
        path: options.path,
        method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
        outcome: "retry",
        attempt,
        errorKind: kind,
        status: error instanceof JupiterHttpError ? error.status : undefined,
        selected: Boolean(budget), delayMs,
      });
      await sleep(delayMs, options.signal);
      if (budget && Date.now() + RETRY_HEADROOM_MS >= budget.deadlineAt) throw error;
      retries += 1;
    }
  }
  throw lastError;
}

/** One Jupiter HTTP request, as the browser must replay it keylessly against `api.jup.ag`. */
export type JupiterRelayRequest = { method: "GET" | "POST"; url: string; body?: unknown };
/** The browser's raw answer to a relayed request: HTTP status plus parsed JSON body. */
export type JupiterRelayResponse = { status: number; body: unknown; retryAfterMs?: number | null };
type JupiterRelayResolver = {
  active(): boolean;
  resolve(request: JupiterRelayRequest): JupiterRelayResponse | "missing" | undefined;
  hint(key: string): string | undefined;
  setHint(key: string, value: string): void;
};

let relayResolver: JupiterRelayResolver | null = null;

/** Installed by `jupiter/relay` (server-only). Kept as a hook so this module stays free of Node built-ins. */
export function setJupiterRelayResolver(resolver: JupiterRelayResolver | null): void {
  relayResolver = resolver;
}

/** True while the current request is served from client-supplied (browser) Jupiter responses. */
export function jupiterRelayActive(): boolean {
  return relayResolver?.active() ?? false;
}

/**
 * Sizing-loop starting point carried between relay rounds (and from preview to
 * prepare). The last allocation tried has its quotes in the browser already, so
 * restarting there survives pool-price drift between rounds instead of
 * re-quoting every iteration. Untrusted: callers bound-check it, and the
 * convergence check decides as before.
 */
export function jupiterRelayHint(key: string): bigint | undefined {
  const value = relayResolver?.active() ? relayResolver.hint(key) : undefined;
  return value !== undefined && /^\d{1,40}$/.test(value) ? BigInt(value) : undefined;
}

export function setJupiterRelayHint(key: string, value: bigint): void {
  if (relayResolver?.active()) relayResolver.setHint(key, value.toString());
}

/** A Jupiter response the browser has not fetched yet. Recorded by the relay context; never retried server-side. */
export class JupiterRelayMissingError extends Error {
  constructor(readonly request: JupiterRelayRequest) {
    super("Jupiter response must be fetched by the client");
    this.name = "JupiterRelayMissingError";
  }
}

function relayBodyError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { error, errorCode } = body as { error?: unknown; errorCode?: unknown };
  if (typeof error === "string" && error.trim()) return error.slice(0, 160);
  if (typeof errorCode === "string" && errorCode.trim()) return errorCode.slice(0, 160);
  return null;
}

function relayedJupiter<T>(options: JupiterRequestOptions, method: string): { hit: true; value: T } | { hit: false } {
  if (!relayResolver?.active()) return { hit: false };
  const url = jupiterUrl(options.path, options.query);
  const request: JupiterRelayRequest = { method: method === "POST" ? "POST" : "GET", url: `${url.pathname}${url.search}`,
    ...(options.body !== undefined ? { body: options.body } : {}) };
  const relayed = relayResolver.resolve(request);
  if (relayed === undefined) return { hit: false };
  if (relayed === "missing") throw new JupiterRelayMissingError(request);
  // Browser 429 / 5xx: do not fail the quote. Fall through to the keyed server fetch.
  if (relayed.status === 429 || relayed.status >= 500) {
    emitJupiterLog({ path: options.path, method, outcome: "retry", status: relayed.status,
      cacheHit: false, retries: 0, relayed: true, quotePath: "server_fallback",
      errorKind: relayed.status === 429 ? "rate-limit" : "http-5xx" });
    return { hit: false };
  }
  emitJupiterLog({ path: options.path, method, outcome: relayed.status >= 200 && relayed.status < 300 ? "ok" : "error",
    status: relayed.status, cacheHit: false, retries: 0, relayed: true, quotePath: "browser" });
  if (relayed.status >= 200 && relayed.status < 300) return { hit: true, value: relayed.body as T };
  throw new JupiterHttpError(relayed.status, options.path, relayed.retryAfterMs ?? null, relayBodyError(relayed.body));
}

export async function jupiterRequest<T>(options: JupiterRequestOptions): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const relayed = relayedJupiter<T>(options, method);
  if (relayed.hit) return relayed.value;
  const quotePath = relayResolver?.active() ? "server_fallback" : "server";
  const cacheable = method === "GET" && options.cacheKey && options.cacheTtlMs;
  const { value, cacheHit } = await withJupiterCache(
    cacheable ? options.cacheKey! : null,
    cacheable ? options.cacheTtlMs! : null,
    async () => {
      const result = await invokeJupiter<T>(options);
      if (!options.budget) emitJupiterLog({
        path: options.path,
        method,
        outcome: "ok",
        retries: result.retries,
        cacheHit: false,
        quotePath,
      });
      return result.value;
    },
  );
  if (cacheHit) {
    emitJupiterLog({ path: options.path, method, outcome: "cache-hit", cacheHit: true, retries: 0, quotePath });
  }
  return value;
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  }));
  return results;
}
