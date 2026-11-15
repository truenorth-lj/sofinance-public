import "server-only";
import type { PortfolioHistoryScheduler } from "./model";
import { mapPortfolioPositions, PORTFOLIO_POSITION_DEADLINE_MS } from "@/lib/dex/portfolio-workers";

const MAX_FLIGHTS = 64;
const flights = new Map<string, Promise<void>>();

/** Request-owned collection; only run() (inside Next after) starts transports. */
export function createPortfolioHistoryBackground(deadline: number) {
  const jobs = new Map<string, (signal: AbortSignal) => Promise<void>>();
  const schedule: PortfolioHistoryScheduler = (key, work) => {
    if (jobs.size < 50 || jobs.has(key)) jobs.set(key, work);
  };
  return { schedule, run: async () => {
    await mapPortfolioPositions([...jobs], async ([key, work]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      // Its originating response owns an existing flight's lifetime. Do not
      // extend this response's deadline by waiting for another response's job.
      if (flights.has(key)) return;
      if (flights.size >= MAX_FLIGHTS) return;
      const signal = AbortSignal.timeout(Math.min(remaining, PORTFOLIO_POSITION_DEADLINE_MS));
      // The database lease remains the cross-instance fence. A failed/expired job
      // leaves its last safe checkpoint so a later read can resume it.
      const flight = Promise.resolve().then(() => work(signal)).catch(() => undefined)
        .finally(() => { if (flights.get(key) === flight) flights.delete(key); });
      flights.set(key, flight);
      await flight;
    });
  } };
}
