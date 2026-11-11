import { abortError } from "./rpc/errors";

/**
 * A timer delay that is safe to hand to `setTimeout`: negative, NaN or infinite values become 0.
 * Runtimes already treat those as "run as soon as possible" (Node warns with TimeoutNegativeWarning first),
 * so clamping keeps the timing and drops the warning.
 */
export function clampDelayMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/** Resolves after `ms`. Rejects at once (and stops the timer) if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, clampDelayMs(ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type WithTimeoutOptions = {
  /** Message of the Error the timeout rejects with. */
  message?: string;
  /** Also rejects (with `signal.reason`, or the timeout error) when this aborts. */
  signal?: AbortSignal;
};

/**
 * Settles like `work`, or rejects with `new Error(message)` after `ms`, whichever comes first. The slow work is
 * not cancelled; it is left to settle on its own. The timer and abort listener are always cleaned up.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, options: WithTimeoutOptions = {}): Promise<T> {
  const message = options.message ?? "timeout";
  const signal = options.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), clampDelayMs(ms));
    if (signal) {
      onAbort = () => reject(signal.reason ?? new Error(message));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}
