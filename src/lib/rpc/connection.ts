import type { Connection } from "@solana/web3.js";
import { classifyRpcError, shouldFallback } from "./errors";
import { policyFor } from "./methods";
import type { MethodPolicy, RpcCallMetric, RpcErrorKind, RpcMetricId } from "./types";

export type InvokeWithPolicyInput<T> = {
  method: string;
  primary: () => Promise<T>;
  fallback?: () => Promise<T>;
  primaryId: RpcMetricId;
  fallbackId?: RpcMetricId;
  policy?: MethodPolicy;
};

export type InvokeWithPolicyResult<T> = {
  value: T;
  servedBy: RpcMetricId;
  fallback: boolean;
  errorKind?: RpcErrorKind;
};

const lastMetric = new WeakMap<object, RpcCallMetric>();

export function lastRpcCallMetric(connection: object): RpcCallMetric | undefined {
  return lastMetric.get(connection);
}

function record(target: object | null, metric: RpcCallMetric) {
  if (target) lastMetric.set(target, metric);
}

/**
 * Shared fallback: try `primary`, and on a policy-matching error (or empty
 * result) retry `fallback`. Used by the Connection proxy and by history
 * listing/parse so those paths do not reimplement classification.
 */
export async function invokeWithPolicy<T>(
  input: InvokeWithPolicyInput<T>,
  recordOn?: object,
): Promise<InvokeWithPolicyResult<T>> {
  const policy = input.policy ?? policyFor(input.method);
  const fallbackId = input.fallbackId ?? "default";

  const succeed = (value: T, servedBy: RpcMetricId, fallback: boolean, errorKind?: RpcErrorKind) => {
    const result: InvokeWithPolicyResult<T> = { value, servedBy, fallback, errorKind };
    record(recordOn ?? null, { method: input.method, servedBy, fallback, errorKind });
    return result;
  };

  try {
    const value = await input.primary();
    if (policy.emptyWhen?.(value) && input.fallback && shouldFallback("empty", policy.fallbackOn)) {
      try {
        const next = await input.fallback();
        return succeed(next, fallbackId, true, "empty");
      } catch {
        return succeed(value, input.primaryId, false, "empty");
      }
    }
    return succeed(value, input.primaryId, false);
  } catch (error) {
    const kind = classifyRpcError(error);
    if (!input.fallback || !policy.fallback || !shouldFallback(kind, policy.fallbackOn)) {
      throw error;
    }
    const next = await input.fallback();
    return succeed(next, fallbackId, true, kind);
  }
}

export type ResilientConnectionOptions = {
  primaryId: RpcMetricId;
  fallbackId: RpcMetricId;
};

/**
 * Prefer `primary` (Solami) for account reads and sends. On classified
 * failures, retry the same call on `fallback` except for send/confirm.
 */
export function createResilientConnection(
  primary: Connection,
  fallback: Connection,
  options: ResilientConnectionOptions = { primaryId: "solami", fallbackId: "default" },
): Connection {
  const proxy = new Proxy(primary, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") {
        return value;
      }
      const policy = policyFor(prop);
      if (!policy.fallback) {
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).then((resolved) => {
              record(proxy, { method: prop, servedBy: options.primaryId, fallback: false });
              return resolved;
            });
          }
          record(proxy, { method: prop, servedBy: options.primaryId, fallback: false });
          return result;
        };
      }
      return (...args: unknown[]) => {
        const next = Reflect.get(fallback, prop);
        const fallbackFn = typeof next === "function"
          ? () => (next as (...a: unknown[]) => unknown).apply(fallback, args)
          : undefined;
        const invoked = invokeWithPolicy({
          method: prop,
          primary: () => value.apply(target, args),
          fallback: fallbackFn
            ? () => Promise.resolve(fallbackFn())
            : undefined,
          primaryId: options.primaryId,
          fallbackId: options.fallbackId,
          policy,
        }, proxy);
        return invoked.then((item) => item.value);
      };
    },
  });
  return proxy;
}
