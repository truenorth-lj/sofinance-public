/**
 * Frozen copy of the engine 0.1.3 two-provider `invokeWithPolicy` / `createResilientConnection`.
 * Test-only: `rpc/legacy-equivalence.test.ts` runs it side by side with the provider pool to prove
 * the single-provider (SOLANA_RPC_URL) configuration behaves exactly as before.
 */
import type { Connection } from "@solana/web3.js";
import { withCacheAndInflight, cacheKeyFor } from "../rpc/cache";
import {
  circuitErrorKind,
  isPrimaryCircuitOpen,
  notePrimaryFailure,
  notePrimarySuccess,
} from "../rpc/circuit";
import { abortError, asRpcUserError, classifyRpcError, isUserAbort, retryAfterFrom, shouldFallback } from "../rpc/errors";
import { emitRpcLog } from "../rpc/logger";
import { cacheTtlFor, policyFor } from "../rpc/methods";
import { invokeWithRetries, type RetryConfig } from "../rpc/retry";
import type { MethodPolicy, RpcCallMetric, RpcErrorKind, RpcFallbackReason, RpcMetricId } from "../rpc/types";

export type InvokeWithPolicyInput<T> = {
  method: string;
  primary: () => Promise<T>;
  fallback?: () => Promise<T>;
  primaryId: RpcMetricId;
  fallbackId?: RpcMetricId;
  policy?: MethodPolicy;
  args?: readonly unknown[];
  signal?: AbortSignal;
  retry?: Partial<RetryConfig> | null;
};

export type InvokeWithPolicyResult<T> = {
  value: T;
  servedBy: RpcMetricId;
  fallback: boolean;
  errorKind?: RpcErrorKind;
  retries: number;
  cacheHit: boolean;
  reason?: RpcFallbackReason;
};

const lastMetric = new WeakMap<object, RpcCallMetric>();

export function lastRpcCallMetric(connection: object): RpcCallMetric | undefined {
  return lastMetric.get(connection);
}

function record(target: object | null, metric: RpcCallMetric) {
  if (target) lastMetric.set(target, metric);
}

function cacheKeyOf(input: InvokeWithPolicyInput<unknown>): string | null {
  if (!input.args) return null;
  const ttl = cacheTtlFor(input.method, input.args);
  return ttl === null || ttl === undefined ? null : cacheKeyFor(input.method, input.args);
}

/**
 * Shared fallback: try `primary` (with 429/5xx/timeout retries), then
 * `fallback` on a policy-matching error or empty result. An open circuit
 * skips a known-dead primary. Used by the Connection proxy, raw JSON-RPC,
 * and history listing/parse.
 */
/**
 * Process-wide cap on concurrent requests to each primary provider. A page load fans out several API
 * routes at once; unbounded, their reads arrive as one burst and trip the provider's rate limit, which
 * then opens the circuit and pushes every read onto the public fallback. Waiters queue in order.
 */
export const PRIMARY_RPC_CONCURRENCY = 6;
const primarySlots = new Map<RpcMetricId, { active: number; waiting: Array<() => void> }>();

async function withPrimarySlot<R>(id: RpcMetricId, signal: AbortSignal | undefined, run: () => Promise<R>): Promise<R> {
  let slots = primarySlots.get(id);
  if (!slots) { slots = { active: 0, waiting: [] }; primarySlots.set(id, slots); }
  const pool = slots;
  if (pool.active >= PRIMARY_RPC_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = pool.waiting.indexOf(admit);
        if (index >= 0) pool.waiting.splice(index, 1);
        reject(abortError(signal));
      };
      const admit = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      pool.waiting.push(admit);
    });
  } else {
    pool.active += 1;
  }
  try {
    return await run();
  } finally {
    const next = pool.waiting.shift();
    if (next) next(); // Hand the slot straight to the next waiter.
    else pool.active -= 1;
  }
}

/** Test hook: current primary slot usage. */
export function primaryRpcSlotUsage(id: RpcMetricId): { active: number; waiting: number } {
  const slots = primarySlots.get(id);
  return { active: slots?.active ?? 0, waiting: slots?.waiting.length ?? 0 };
}

export async function invokeWithPolicy<T>(
  input: InvokeWithPolicyInput<T>,
  recordOn?: object,
): Promise<InvokeWithPolicyResult<T>> {
  const policy = input.policy ?? policyFor(input.method);
  const fallbackId = input.fallbackId ?? "default";
  const ttl = input.args ? cacheTtlFor(input.method, input.args) : null;
  const key = cacheKeyOf(input);

  const succeed = (
    value: T,
    servedBy: RpcMetricId,
    fallback: boolean,
    extras: { errorKind?: RpcErrorKind; retries: number; cacheHit: boolean; reason?: RpcFallbackReason },
  ) => {
    const result: InvokeWithPolicyResult<T> = {
      value,
      servedBy,
      fallback,
      errorKind: extras.errorKind,
      retries: extras.retries,
      cacheHit: extras.cacheHit,
      reason: extras.reason,
    };
    record(recordOn ?? null, {
      method: input.method,
      servedBy,
      fallback,
      errorKind: extras.errorKind,
      retries: extras.retries,
      cacheHit: extras.cacheHit,
    });
    emitRpcLog({
      method: input.method,
      provider: servedBy,
      outcome: extras.cacheHit ? "cache-hit" : fallback ? "fallback" : "ok",
      retries: extras.retries,
      cacheHit: extras.cacheHit,
      errorKind: extras.errorKind,
      reason: extras.reason,
    });
    return result;
  };

  const runProvider = (run: () => Promise<T>, id: RpcMetricId) =>
    invokeWithRetries(run, { method: input.method, providerId: id, signal: input.signal, retry: input.retry });

  const runPrimaryLimited = () => withPrimarySlot(input.primaryId, input.signal, () => runProvider(input.primary, input.primaryId));

  const runFallback = async (
    kind: RpcErrorKind | undefined,
    reason: RpcFallbackReason,
  ): Promise<InvokeWithPolicyResult<T>> => {
    try {
      const next = await runProvider(input.fallback!, fallbackId);
      return succeed(next.value, fallbackId, true, {
        errorKind: kind,
        retries: next.retries,
        cacheHit: false,
        reason,
      });
    } catch (fallbackError) {
      if (isUserAbort(fallbackError, input.signal)) throw fallbackError;
      emitRpcLog({
        method: input.method,
        provider: fallbackId,
        outcome: "error",
        errorKind: classifyRpcError(fallbackError),
        reason,
      });
      throw asRpcUserError(fallbackError);
    }
  };

  const execute = async (): Promise<InvokeWithPolicyResult<T>> => {
    if (input.fallback && policy.fallback && isPrimaryCircuitOpen(input.primaryId)) {
      const openKind = circuitErrorKind(input.primaryId);
      try {
        return await runFallback(openKind, "circuit-open");
      } catch (fallbackError) {
        // A rate-limited primary is still the better bet than a refusing public fallback: give it
        // one more (retried, backoff-honoring) try instead of failing the request outright.
        if (isUserAbort(fallbackError, input.signal) || openKind !== "rate-limit") throw fallbackError;
        try {
          const retried = await runPrimaryLimited();
          notePrimarySuccess(input.primaryId);
          return succeed(retried.value, input.primaryId, false, { retries: retried.retries, cacheHit: false });
        } catch (primaryError) {
          if (isUserAbort(primaryError, input.signal)) throw primaryError;
          notePrimaryFailure(input.primaryId, classifyRpcError(primaryError), retryAfterFrom(primaryError));
          throw asRpcUserError(primaryError);
        }
      }
    }
    try {
      const first = await runPrimaryLimited();
      notePrimarySuccess(input.primaryId);
      if (policy.emptyWhen?.(first.value) && input.fallback && shouldFallback("empty", policy.fallbackOn)) {
        try {
          const next = await runProvider(input.fallback, fallbackId);
          return succeed(next.value, fallbackId, true, {
            errorKind: "empty",
            retries: first.retries + next.retries,
            cacheHit: false,
            reason: "primary-error",
          });
        } catch (error) {
          if (isUserAbort(error, input.signal)) throw error;
          return succeed(first.value, input.primaryId, false, {
            errorKind: "empty",
            retries: first.retries,
            cacheHit: false,
          });
        }
      }
      return succeed(first.value, input.primaryId, false, { retries: first.retries, cacheHit: false });
    } catch (error) {
      if (isUserAbort(error, input.signal)) throw error;
      const kind = classifyRpcError(error);
      notePrimaryFailure(input.primaryId, kind, retryAfterFrom(error));
      if (!input.fallback || !policy.fallback || !shouldFallback(kind, policy.fallbackOn)) {
        emitRpcLog({
          method: input.method,
          provider: input.primaryId,
          outcome: "error",
          errorKind: kind,
        });
        throw asRpcUserError(error);
      }
      return runFallback(kind, "primary-error");
    }
  };

  const wrapped = await withCacheAndInflight(key, ttl, execute);
  if (wrapped.cacheHit) {
    return succeed(wrapped.value.value, wrapped.value.servedBy, wrapped.value.fallback, {
      errorKind: wrapped.value.errorKind,
      retries: 0,
      cacheHit: true,
    });
  }
  return wrapped.value;
}

export type ResilientConnectionOptions = {
  primaryId: RpcMetricId;
  fallbackId: RpcMetricId;
  signal?: AbortSignal;
  retry?: Partial<RetryConfig> | null;
};

function managedConnectionMethod(name: string): boolean {
  if (name === "_rpcRequest") return true;
  if (name.startsWith("_") || name.startsWith("on") || name.startsWith("remove")) return false;
  return true;
}

/**
 * Prefer `primary` for account reads and sends. Same-provider retries
 * cover 429 / 5xx / timeout. On classified failures (including send/confirm
 * auth, rate-limit, 5xx, and timeout), retry the same call on `fallback`.
 */
export function createResilientConnection(
  primary: Connection,
  fallback: Connection | null = null,
  options: ResilientConnectionOptions = { primaryId: "default", fallbackId: "default" },
): Connection {
  const proxy = new Proxy(primary, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function" || !managedConnectionMethod(prop)) {
        return value;
      }
      const policy = policyFor(prop);
      return (...args: unknown[]) => {
        const next = fallback ? Reflect.get(fallback, prop) : undefined;
        const fallbackFn = policy.fallback && typeof next === "function"
          ? () => Promise.resolve((next as (...a: unknown[]) => unknown).apply(fallback, args))
          : undefined;
        return invokeWithPolicy({
          method: prop,
          args,
          signal: options.signal,
          retry: options.retry,
          primary: () => Promise.resolve(value.apply(target, args)),
          fallback: fallbackFn,
          primaryId: options.primaryId,
          fallbackId: options.fallbackId,
          policy,
        }, proxy).then((item) => item.value);
      };
    },
  });
  return proxy;
}
