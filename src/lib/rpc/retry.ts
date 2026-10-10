import { abortError, classifyRpcError, isRetryableKind, isUserAbort, retryAfterFrom } from "./errors";
import { emitRpcLog } from "./logger";
import type { RpcErrorKind, RpcMetricId } from "./types";

export type RetryConfig = {
  maxAttempts: number;
  baseMs: number;
  maxDelayMs: number;
  budgetMs: number;
};

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseMs: 200,
  maxDelayMs: 2_000,
  budgetMs: 8_000,
};

let override: Partial<RetryConfig> | null = null;

export function setRpcRetryConfig(config: Partial<RetryConfig> | null): void {
  override = config;
}

export function retryConfig(): RetryConfig {
  return { ...DEFAULT_RETRY, ...override };
}

/** `Retry-After` as milliseconds (delta-seconds or HTTP-date). */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

/**
 * Full jitter: `random() * min(max, base * 2^(failedAttempt-1))`.
 * `Retry-After` wins when present, capped at `maxDelayMs`.
 */
export function computeBackoffMs(
  failedAttempt: number,
  options: { retryAfterMs?: number | null; random?: () => number; config?: RetryConfig } = {},
): number {
  const config = options.config ?? retryConfig();
  if (options.retryAfterMs != null && options.retryAfterMs >= 0) {
    return Math.min(options.retryAfterMs, config.maxDelayMs);
  }
  const random = options.random ?? Math.random;
  const exp = Math.min(config.maxDelayMs, config.baseMs * 2 ** Math.max(0, failedAttempt - 1));
  return Math.floor(random() * exp);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function invokeWithRetries<T>(
  run: () => Promise<T>,
  options: {
    method: string;
    providerId: RpcMetricId;
    signal?: AbortSignal;
    onRetry?: (info: { attempt: number; delayMs: number; errorKind: RpcErrorKind }) => void;
  },
): Promise<{ value: T; retries: number }> {
  const config = retryConfig();
  const started = Date.now();
  let retries = 0;
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return { value: await run(), retries };
    } catch (error) {
      lastError = error;
      if (isUserAbort(error, options.signal)) throw error;
      const kind = classifyRpcError(error);
      const elapsed = Date.now() - started;
      const canRetry = isRetryableKind(kind) && attempt < config.maxAttempts && elapsed < config.budgetMs;
      if (!canRetry) throw error;
      const delayMs = computeBackoffMs(attempt, { retryAfterMs: retryAfterFrom(error) });
      if (elapsed + delayMs > config.budgetMs) throw error;
      options.onRetry?.({ attempt, delayMs, errorKind: kind });
      emitRpcLog({
        method: options.method,
        provider: options.providerId,
        outcome: "retry",
        attempt,
        errorKind: kind,
      });
      await sleep(delayMs, options.signal);
      retries += 1;
    }
  }
  throw lastError;
}
