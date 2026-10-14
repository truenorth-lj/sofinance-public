export const POSITION_HISTORY_WORKER_COUNT = 8;

/**
 * Refill free slots immediately and retain listing order in the result.
 * Abort/fatal errors stop dispatch; all already-started jobs settle before exit.
 */
export async function mapPositionHistoryWorkers<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let stopped = false;
  let failure: unknown;
  const stop = (reason: unknown) => {
    if (stopped) return;
    stopped = true;
    failure = reason;
  };
  const onAbort = () => stop(options.signal?.reason ?? new DOMException("Position history lookup aborted", "AbortError"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const work = async () => {
      while (!stopped && nextIndex < items.length) {
        const index = nextIndex++;
        try { results[index] = await fn(items[index]!, index); }
        catch (error) { stop(error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POSITION_HISTORY_WORKER_COUNT, items.length) }, work));
    if (stopped) throw failure;
    return results;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
