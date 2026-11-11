export type JsonStatus = { status: number; body: unknown };

export type FetchJsonStatusOptions = {
  fetcher?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Caller cancellation, combined with the timeout. */
  signal?: AbortSignal;
};

/**
 * GET `url` as JSON: the HTTP status, and the parsed body when the response is 2xx (otherwise null, body unread).
 * Network errors, timeouts, aborts and invalid JSON on a 2xx reject, so callers decide how to treat them.
 */
export async function fetchJsonStatus(url: string, options: FetchJsonStatusOptions): Promise<JsonStatus> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const response = await (options.fetcher ?? fetch)(url, {
    headers: { accept: "application/json" },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  return { status: response.status, body: response.ok ? ((await response.json()) as unknown) : null };
}
