// Server-only request scope: "the protocol fee for this deposit was already
// collected upstream" (step 1/2 of a two-transaction SOL open charged 10 bps
// inside its Jupiter swap). `readSwapFeeConfig` then returns no fee.
import { AsyncLocalStorage } from "node:async_hooks";

const holder = globalThis as { __sofiSwapFeePaidUpstream?: AsyncLocalStorage<true> };
const store = holder.__sofiSwapFeePaidUpstream ??= new AsyncLocalStorage<true>();

export function runWithSwapFeePaidUpstream<T>(fn: () => T): T {
  return store.run(true, fn);
}
