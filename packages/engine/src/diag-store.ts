// THROWAWAY DIAGNOSTIC — DO NOT MERGE. Server-only request-scoped variant store.
import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenDiagVariant } from "./diag";

const holder = globalThis as { __sofiOpenDiagStore?: AsyncLocalStorage<OpenDiagVariant> };
const store = holder.__sofiOpenDiagStore ??= new AsyncLocalStorage<OpenDiagVariant>();

export function runWithOpenDiag<T>(variant: OpenDiagVariant | undefined, fn: () => T): T {
  // The host must pass a variant only after parseOpenDiag (production guard).
  if (!variant) return fn();
  return store.run(variant, fn);
}
