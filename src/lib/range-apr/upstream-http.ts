/**
 * One JSON GET to a public upstream with a timeout, the HTTP status and Retry-After kept (pure apart from the
 * injected fetcher). `init` is merged into the request; the server passes Next's `next.revalidate` here so
 * successful responses live in the Data Cache shared by all instances and survive cold starts.
 */
import type { JsonResult } from "./upstream-retry";

export const UPSTREAM_USER_AGENT =
  "SoFinance/0.1 (range APR; +https://sofinancelab.xyz)";

/** Seconds ("120") or an HTTP date; null when absent or unusable. */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

export async function fetchJsonOnce(
  fetcher: typeof fetch, url: string, timeoutMs: number, init: RequestInit = {}, nowMs: () => number = Date.now,
): Promise<JsonResult> {
  try {
    const response = await fetcher(url, {
      ...init,
      headers: { Accept: "application/json", "User-Agent": UPSTREAM_USER_AGENT },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), nowMs()) ?? undefined;
      return { ok: false, reason: `Upstream request failed (${response.status})`, status: response.status, retryAfterMs };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "request failed" };
  }
}
