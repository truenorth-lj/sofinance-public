import { setTimeout as delay } from "node:timers/promises";
import { sanitizePublicError } from "./public-error";

/** Retry only rate-limited reads/simulations, never restart the whole preview. */
export function exitRpcFetch(fetcher: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetcher(url, { ...init, signal });
      let limited = response.status === 429;
      if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        limited = body?.error?.code === 429;
      }
      if (!limited || attempt >= 2) return response;
      const header = response.headers.get("Retry-After");
      const seconds = header === null ? NaN : Number(header);
      const requested = Number.isFinite(seconds)
        ? seconds * 1000
        : header ? Date.parse(header) - Date.now() : NaN;
      // Do not retry earlier than a long provider cooldown, or wait indefinitely.
      if (requested > 10000) return response;
      const wait = Math.max(1000 * 2 ** attempt, Number.isFinite(requested) ? requested : 0);
      await response.body?.cancel();
      await delay(wait, undefined, { signal });
    }
  };
}

export function exitPreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) {
    return "Exit preview is temporarily unavailable because the data service is busy (rate limit). Please wait a little and try again. No transaction was sent.";
  }
  if (/timeout|timed out|TimeoutError/i.test(message)) {
    return "Exit preview took too long. Please try again shortly. No transaction was sent.";
  }
  if (/fetch failed|ECONN|ENOTFOUND|\b50[234]\b/i.test(message)) {
    return "The data service is temporarily unreachable. Please try again shortly. No transaction was sent.";
  }
  return sanitizePublicError(error, "Exit preview is unavailable. Please try again shortly.");
}
