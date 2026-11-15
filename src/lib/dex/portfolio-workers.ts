const PORTFOLIO_CONCURRENCY = 2;
export const PORTFOLIO_POSITION_DEADLINE_MS = 12_000;

/** Failures are isolated by each job; completed slots are refilled without changing result order. */
export async function mapPortfolioPositions<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(items.length);
  await Promise.all(Array.from({ length: Math.min(PORTFOLIO_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  }));
  return results;
}

export function portfolioAbortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

