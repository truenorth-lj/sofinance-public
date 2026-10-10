import type { Connection } from "@solana/web3.js";
import { withCacheAndInflight, cacheKeyFor } from "./cache";
import { asRpcUserError, classifyRpcError, isUserAbort, shouldFallback } from "./errors";
import { emitRpcLog } from "./logger";
import { cacheTtlFor, policyFor } from "./methods";
import { invokeWithRetries, type RetryConfig } from "./retry";
import type { MethodPolicy, RpcCallMetric, RpcErrorKind, RpcMetricId } from "./types";

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
 * `fallback` on a policy-matching error or empty result. Used by the
 * Connection proxy, raw JSON-RPC, and history listing/parse.
 */
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
    extras: { errorKind?: RpcErrorKind; retries: number; cacheHit: boolean },
  ) => {
    const result: InvokeWithPolicyResult<T> = {
      value,
      servedBy,
      fallback,
      errorKind: extras.errorKind,
      retries: extras.retries,
      cacheHit: extras.cacheHit,
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
    });
    return result;
  };

  const runProvider = (run: () => Promise<T>, id: RpcMetricId) =>
    invokeWithRetries(run, { method: input.method, providerId: id, signal: input.signal, retry: input.retry });

  const execute = async (): Promise<InvokeWithPolicyResult<T>> => {
    try {
      const first = await runProvider(input.primary, input.primaryId);
      if (policy.emptyWhen?.(first.value) && input.fallback && shouldFallback("empty", policy.fallbackOn)) {
        try {
          const next = await runProvider(input.fallback, fallbackId);
          return succeed(next.value, fallbackId, true, {
            errorKind: "empty",
            retries: first.retries + next.retries,
            cacheHit: false,
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
      if (!input.fallback || !policy.fallback || !shouldFallback(kind, policy.fallbackOn)) {
        emitRpcLog({
          method: input.method,
          provider: input.primaryId,
          outcome: "error",
          errorKind: kind,
        });
        throw asRpcUserError(error);
      }
      try {
        const next = await runProvider(input.fallback, fallbackId);
        return succeed(next.value, fallbackId, true, { errorKind: kind, retries: next.retries, cacheHit: false });
      } catch (fallbackError) {
        if (isUserAbort(fallbackError, input.signal)) throw fallbackError;
        emitRpcLog({
          method: input.method,
          provider: fallbackId,
          outcome: "error",
          errorKind: classifyRpcError(fallbackError),
        });
        throw asRpcUserError(fallbackError);
      }
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
 * Prefer `primary` (Solami) for account reads and sends. Same-provider retries
 * cover 429 / 5xx / timeout. On classified failures, retry the same call on
 * `fallback` except for send/confirm.
 */
export function createResilientConnection(
  primary: Connection,
  fallback: Connection | null = null,
  options: ResilientConnectionOptions = { primaryId: "solami", fallbackId: "default" },
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
