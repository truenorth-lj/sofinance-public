import { abortError, isUserAbort } from "../rpc/errors";
import { computeBackoffMs, retryConfig, sleep, type RetryConfig } from "../rpc/retry";
import { quoteCacheKey, withJupiterCache } from "./cache";
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

/** Best-effort price / metadata lookups. */
export const JUPITER_SOFT_RETRY: RetryConfig = {
  maxAttempts: 2,
  baseMs: 200,
  maxDelayMs: 1_000,
  budgetMs: 4_000,
};

export const JUPITER_QUOTE_TTL_MS = 8_000;
export const JUPITER_PRICE_TTL_MS = 10_000;
export const EXIT_JUPITER_CONCURRENCY = 2;

let override: Partial<RetryConfig> | null = null;

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
};

export type JupiterQuoteParams = {
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
    const json = JSON.parse(text) as { error?: unknown };
    return typeof json.error === "string" ? json.error.slice(0, 160) : null;
  } catch {
    return null;
  }
}

async function fetchJupiterOnce<T>(options: JupiterRequestOptions): Promise<T> {
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
    signal: options.signal,
    ...(options.next ? { next: options.next } : {}),
  } as RequestInit);
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
      return { value: await fetchJupiterOnce<T>(options), retries };
    } catch (error) {
      lastError = error;
      if (isUserAbort(error, options.signal)) throw error;
      const kind = classifyJupiterError(error);
      const elapsed = Date.now() - started;
      const canRetry = isRetryableJupiterKind(kind) && attempt < config.maxAttempts && elapsed < config.budgetMs;
      if (!canRetry) throw error;
      const delayMs = computeBackoffMs(attempt, {
        retryAfterMs: error instanceof JupiterHttpError ? error.retryAfterMs : null,
        config,
      });
      if (elapsed + delayMs > config.budgetMs) throw error;
      emitJupiterLog({
        path: options.path,
        method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
        outcome: "retry",
        attempt,
        errorKind: kind,
        status: error instanceof JupiterHttpError ? error.status : undefined,
      });
      await sleep(delayMs, options.signal);
      retries += 1;
    }
  }
  throw lastError;
}

export async function jupiterRequest<T>(options: JupiterRequestOptions): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const cacheable = method === "GET" && options.cacheKey && options.cacheTtlMs;
  const { value, cacheHit } = await withJupiterCache(
    cacheable ? options.cacheKey! : null,
    cacheable ? options.cacheTtlMs! : null,
    async () => {
      const result = await invokeJupiter<T>(options);
      emitJupiterLog({
        path: options.path,
        method,
        outcome: "ok",
        retries: result.retries,
        cacheHit: false,
      });
      return result.value;
    },
  );
  if (cacheHit) {
    emitJupiterLog({ path: options.path, method, outcome: "cache-hit", cacheHit: true, retries: 0 });
  }
  return value;
}

export async function jupiterQuote<T = Record<string, unknown>>(params: JupiterQuoteParams): Promise<T> {
  const slippageBps = params.slippageBps ?? 50;
  const query = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps,
    ...(params.maxAccounts !== undefined ? { maxAccounts: params.maxAccounts } : {}),
    ...(params.onlyDirectRoutes ? { onlyDirectRoutes: true } : {}),
  };
  return jupiterRequest<T>({
    path: "/swap/v1/quote",
    query,
    signal: params.signal,
    fetcher: params.fetcher,
    apiKey: params.apiKey,
    cacheKey: quoteCacheKey({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps,
      maxAccounts: params.maxAccounts,
      onlyDirectRoutes: params.onlyDirectRoutes,
    }),
    cacheTtlMs: JUPITER_QUOTE_TTL_MS,
  });
}

export async function jupiterQuotePreferCompact<T = Record<string, unknown>>(
  params: Omit<JupiterQuoteParams, "maxAccounts" | "onlyDirectRoutes"> & { maxAccounts?: number },
): Promise<T> {
  try {
    return await jupiterQuote<T>({ ...params, maxAccounts: params.maxAccounts ?? 16, onlyDirectRoutes: true });
  } catch (error) {
    if (!(error instanceof JupiterHttpError) || error.status !== 400) throw error;
    return jupiterQuote<T>({ ...params, maxAccounts: 20, onlyDirectRoutes: true });
  }
}

export async function jupiterSwapInstructions<T = Record<string, unknown>>(
  body: unknown,
  options: Pick<JupiterRequestOptions, "signal" | "fetcher" | "apiKey"> = {},
): Promise<T> {
  return jupiterRequest<T>({
    path: "/swap/v1/swap-instructions",
    method: "POST",
    body,
    signal: options.signal,
    fetcher: options.fetcher,
    apiKey: options.apiKey,
    cacheKey: null,
    cacheTtlMs: null,
  });
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
