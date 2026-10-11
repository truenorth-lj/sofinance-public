/**
 * Bounded retry for flaky public upstreams (GeckoTerminal answers 429 / 5xx under bursts from shared egress IPs).
 * Pure apart from the injected `fetchOnce` and `sleep`, so it is unit tested without timers.
 */
export type JsonResult = { ok: true; body: unknown } | { ok: false; reason: string };

export type RetryOptions = {
  /** Total attempts including the first one. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1); injectable for tests. */
  random?: () => number;
};

const RETRYABLE = /\((429|5\d\d)\)|timed? ?out|abort|fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN/i;

/** True for rate limits, server errors, timeouts and network errors; false for 4xx such as 404 (pool not indexed). */
export function isRetryableFailure(reason: string): boolean {
  return RETRYABLE.test(reason);
}

/** Runs `fetchOnce` until it succeeds, hits a non-retryable failure, or runs out of attempts. */
export async function retryJson(fetchOnce: () => Promise<JsonResult>, options: RetryOptions = {}): Promise<JsonResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 400;
  const max = options.maxDelayMs ?? 2_500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  let last: JsonResult = { ok: false, reason: "request failed" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await fetchOnce();
    if (last.ok || !isRetryableFailure(last.reason)) return last;
    if (attempt < attempts - 1) await sleep(Math.min(max, base * 2 ** attempt) * (0.75 + random() * 0.5));
  }
  return last;
}
