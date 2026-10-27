import type { Connection } from "@solana/web3.js";
import { withCacheAndInflight, cacheKeyFor } from "./cache";
import {
  circuitErrorKind,
  isPrimaryCircuitOpen,
  notePrimaryFailure,
  notePrimarySuccess,
} from "./circuit";
import { abortError, asRpcUserError, classifyRpcError, isUserAbort, retryAfterFrom, shouldFallback } from "./errors";
import { emitRpcLog } from "./logger";
import { cacheTtlFor, policyFor } from "./methods";
import {
  effectiveRoute,
  legacyFallbackMember,
  legacyPrimaryMember,
  routeMembers,
  type RpcPool,
  type RpcPoolMember,
} from "./pool";
import { rateLimiterFor, type TokenBucket } from "./rate-limit";
import { invokeWithRetries, type RetryConfig } from "./retry";
import { spreadsReads, weightedReadOrder } from "./select";
import type { MethodPolicy, RpcCallMetric, RpcErrorKind, RpcFallbackReason, RpcMetricId } from "./types";

export { PRIMARY_RPC_CONCURRENCY } from "./pool";

/** One provider a call may run on, in route order. Built from an `RpcPoolMember` by `attemptFor`. */
export type ProviderAttempt<T> = {
  key: string;
  name?: string;
  metricId: RpcMetricId;
  run: () => Promise<T>;
  maxConcurrency: number | null;
  limiter: TokenBucket | null;
  trackHealth: boolean;
  rateLimitMaxCooldownMs: number | null;
  /** When its rate budget is spent, hand the call to a later provider instead of waiting. */
  overflow: boolean;
};

export type InvokeAcrossProvidersInput<T> = {
  method: string;
  attempts: readonly ProviderAttempt<T>[];
  policy?: MethodPolicy;
  args?: readonly unknown[];
  signal?: AbortSignal;
  retry?: Partial<RetryConfig> | null;
  /** Called with the serving provider's key on a non-cached success (drives stickiness). */
  onServed?: (key: string) => void;
  /** Read route of an env pool: wait and retry a provider that is behind `minContextSlot`. */
  retryMinContextSlot?: boolean;
};

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
  /** Pool provider name, when the serving provider came from SOLANA_RPC_PROVIDERS. */
  via?: string;
};

const lastMetric = new WeakMap<object, RpcCallMetric>();

export function lastRpcCallMetric(connection: object): RpcCallMetric | undefined {
  return lastMetric.get(connection);
}

/** Serving provider key per result object (kept off the result so its shape stays as before). */
const servedKeys = new WeakMap<object, string>();

function record(target: object | null, metric: RpcCallMetric) {
  if (target) lastMetric.set(target, metric);
}

/**
 * Process-wide cap on concurrent requests per provider key. A page load fans out several API routes at
 * once; unbounded, their reads arrive as one burst and trip the provider's rate limit. Waiters queue
 * in order. The legacy primary uses PRIMARY_RPC_CONCURRENCY; pool providers use `maxConcurrency`.
 */
const slotPools = new Map<string, { active: number; waiting: Array<() => void> }>();

async function withSlot<R>(key: string, limit: number, signal: AbortSignal | undefined, run: () => Promise<R>): Promise<R> {
  let slots = slotPools.get(key);
  if (!slots) { slots = { active: 0, waiting: [] }; slotPools.set(key, slots); }
  const pool = slots;
  if (pool.active >= limit) {
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

/** Test hook: current slot usage for a provider key (the legacy primary's key is its metric id). */
export function primaryRpcSlotUsage(id: string): { active: number; waiting: number } {
  const slots = slotPools.get(id);
  return { active: slots?.active ?? 0, waiting: slots?.waiting.length ?? 0 };
}

export function attemptFor<T>(member: RpcPoolMember, run: () => Promise<T>, overflow = false): ProviderAttempt<T> {
  return {
    key: member.key,
    name: member.name,
    metricId: member.metricId,
    run,
    maxConcurrency: member.maxConcurrency,
    limiter: rateLimiterFor(member.key, member.rps, member.burst),
    trackHealth: member.trackHealth,
    rateLimitMaxCooldownMs: member.rateLimitMaxCooldownMs,
    overflow,
  };
}

function isAvailable(attempt: ProviderAttempt<unknown>): boolean {
  if (attempt.trackHealth && isPrimaryCircuitOpen(attempt.key)) return false;
  return !attempt.limiter || attempt.limiter.available();
}

type Failover = { kind?: RpcErrorKind; reason: RpcFallbackReason };

/**
 * Runs one RPC call down an ordered provider list:
 * 1. Skip a provider whose circuit is open (never the last one), and — for overflow-enabled reads — one
 *    whose local rate budget is spent while a later provider has budget.
 * 2. Run it with same-provider retries (429 / 5xx / timeout); on a policy-listed error, move on.
 * 3. An empty result (per policy) tries the next provider once.
 * 4. If everything after a rate-limit-parked provider failed, give the parked one a final try.
 * With two providers this is exactly the pre-pool primary → fallback behaviour.
 */
export async function invokeAcrossProviders<T>(
  input: InvokeAcrossProvidersInput<T>,
  recordOn?: object,
): Promise<InvokeWithPolicyResult<T>> {
  const policy = input.policy ?? policyFor(input.method);
  const attempts = input.attempts;
  if (attempts.length === 0) throw new Error(`No RPC provider configured for ${input.method}`);
  const ttl = input.args ? cacheTtlFor(input.method, input.args) : null;
  const cacheKey = ttl === null || ttl === undefined || !input.args ? null : cacheKeyFor(input.method, input.args);

  const succeed = (
    value: T,
    served: { key?: string; name?: string; metricId: RpcMetricId },
    fallback: boolean,
    extras: { errorKind?: RpcErrorKind; retries: number; cacheHit: boolean; reason?: RpcFallbackReason },
  ): InvokeWithPolicyResult<T> => {
    const via = served.name ? { via: served.name } : {};
    const result: InvokeWithPolicyResult<T> = {
      value,
      servedBy: served.metricId,
      fallback,
      errorKind: extras.errorKind,
      retries: extras.retries,
      cacheHit: extras.cacheHit,
      reason: extras.reason,
      ...via,
    };
    if (served.key) servedKeys.set(result, served.key);
    record(recordOn ?? null, {
      method: input.method,
      servedBy: served.metricId,
      fallback,
      errorKind: extras.errorKind,
      retries: extras.retries,
      cacheHit: extras.cacheHit,
      ...via,
    });
    emitRpcLog({
      method: input.method,
      provider: served.metricId,
      outcome: extras.cacheHit ? "cache-hit" : fallback ? "fallback" : "ok",
      retries: extras.retries,
      cacheHit: extras.cacheHit,
      errorKind: extras.errorKind,
      reason: extras.reason,
      ...via,
    });
    return result;
  };

  const run = (attempt: ProviderAttempt<T>, prepaid = false) => {
    const limiter = attempt.limiter;
    let tokenInHand = prepaid;
    const call = limiter
      ? async () => {
          if (tokenInHand) tokenInHand = false;
          else await limiter.take(input.signal);
          return attempt.run();
        }
      : attempt.run;
    const retried = () => invokeWithRetries(call, {
      method: input.method,
      providerId: attempt.metricId,
      signal: input.signal,
      retry: input.retry,
      retryMinContextSlot: input.retryMinContextSlot,
    });
    return attempt.maxConcurrency === null ? retried() : withSlot(attempt.key, attempt.maxConcurrency, input.signal, retried);
  };

  const noteSuccess = (attempt: ProviderAttempt<T>) => {
    if (attempt.trackHealth) notePrimarySuccess(attempt.key);
  };
  const noteFailure = (attempt: ProviderAttempt<T>, kind: RpcErrorKind, error: unknown) => {
    if (attempt.trackHealth) notePrimaryFailure(attempt.key, kind, retryAfterFrom(error), attempt.rateLimitMaxCooldownMs);
  };

  // A rate-limited provider is still a better bet than failing outright: one last, backoff-honouring try.
  const retryParked = async (attempt: ProviderAttempt<T>): Promise<InvokeWithPolicyResult<T>> => {
    try {
      const retried = await run(attempt);
      noteSuccess(attempt);
      return succeed(retried.value, attempt, false, { retries: retried.retries, cacheHit: false });
    } catch (error) {
      if (isUserAbort(error, input.signal)) throw error;
      noteFailure(attempt, classifyRpcError(error), error);
      throw asRpcUserError(error);
    }
  };

  const execute = async (): Promise<InvokeWithPolicyResult<T>> => {
    let failover: Failover | null = null;
    let overflowed = false;
    let parked: ProviderAttempt<T> | null = null;

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      const later = attempts.slice(index + 1);
      const mayMoveOn = later.length > 0 && policy.fallback;

      if (mayMoveOn && attempt.trackHealth && isPrimaryCircuitOpen(attempt.key)) {
        const openKind = circuitErrorKind(attempt.key);
        if (openKind === "rate-limit") parked ??= attempt;
        failover ??= { kind: openKind, reason: "circuit-open" };
        continue;
      }

      let prepaid = false;
      if (mayMoveOn && attempt.overflow && attempt.limiter) {
        prepaid = attempt.limiter.tryTake();
        if (!prepaid && later.some(isAvailable)) {
          overflowed = true;
          continue;
        }
      }

      try {
        const first = await run(attempt, prepaid);
        noteSuccess(attempt);
        const next = attempts[index + 1];
        if (policy.emptyWhen?.(first.value) && next && shouldFallback("empty", policy.fallbackOn)) {
          try {
            const second = await run(next);
            return succeed(second.value, next, true, {
              errorKind: "empty",
              retries: first.retries + second.retries,
              cacheHit: false,
              reason: "primary-error",
            });
          } catch (error) {
            if (isUserAbort(error, input.signal)) throw error;
            return succeed(first.value, attempt, failover !== null, {
              errorKind: "empty",
              retries: first.retries,
              cacheHit: false,
              reason: failover?.reason,
            });
          }
        }
        return succeed(first.value, attempt, failover !== null, {
          errorKind: failover?.kind,
          retries: first.retries,
          cacheHit: false,
          reason: failover?.reason ?? (overflowed ? "local-rate-limit" : undefined),
        });
      } catch (error) {
        if (isUserAbort(error, input.signal)) throw error;
        const kind = classifyRpcError(error);
        noteFailure(attempt, kind, error);
        if (!mayMoveOn || !shouldFallback(kind, policy.fallbackOn)) {
          emitRpcLog({
            method: input.method,
            provider: attempt.metricId,
            outcome: "error",
            errorKind: kind,
            ...(failover ? { reason: failover.reason } : {}),
            ...(attempt.name ? { via: attempt.name } : {}),
          });
          if (parked) return retryParked(parked);
          throw asRpcUserError(error);
        }
        failover ??= { kind, reason: "primary-error" };
      }
    }
    throw new Error(`No RPC provider attempted ${input.method}`); // Unreachable: the last provider always runs.
  };

  const wrapped = await withCacheAndInflight(cacheKey, ttl, execute);
  if (wrapped.cacheHit) {
    const cached = wrapped.value;
    return succeed(cached.value, { name: cached.via, metricId: cached.servedBy }, cached.fallback, {
      errorKind: cached.errorKind,
      retries: 0,
      cacheHit: true,
    });
  }
  const servedKey = servedKeys.get(wrapped.value);
  if (servedKey) input.onServed?.(servedKey);
  return wrapped.value;
}

/**
 * Two-provider entry point (primary, optional fallback), kept for callers that bring their own
 * functions (history listing, raw JSON-RPC tests). Same semantics as engine 0.1.3.
 */
export async function invokeWithPolicy<T>(
  input: InvokeWithPolicyInput<T>,
  recordOn?: object,
): Promise<InvokeWithPolicyResult<T>> {
  const attempts = [attemptFor(legacyPrimaryMember(input.primaryId, ""), input.primary)];
  if (input.fallback) attempts.push(attemptFor(legacyFallbackMember(input.fallbackId ?? "default", ""), input.fallback));
  return invokeAcrossProviders({
    method: input.method,
    attempts,
    policy: input.policy,
    args: input.args,
    signal: input.signal,
    retry: input.retry,
  }, recordOn);
}

export type PooledConnectionOptions = {
  signal?: AbortSignal;
  retry?: Partial<RetryConfig> | null;
  /** Read-only connection: slot-context reads may use the read providers too. Never send on it. */
  readOnly?: boolean;
};

function managedConnectionMethod(name: string): boolean {
  if (name === "_rpcRequest") return true;
  if (name.startsWith("_") || name.startsWith("on") || name.startsWith("remove")) return false;
  return true;
}

function callOn(connection: Connection, method: string, args: unknown[]): Promise<unknown> {
  const fn = Reflect.get(connection, method) as (...a: unknown[]) => unknown;
  return Promise.resolve(fn.apply(connection, args));
}

/**
 * A web3.js Connection whose every RPC method is routed through the provider pool: transaction methods
 * strictly down the transaction providers, reads to the first healthy provider with budget. Reads stay
 * on the provider that served this connection's previous call (one connection ≈ one request) so slot
 * context does not jump between providers. Non-RPC properties come from the first transaction provider.
 */
export function createPooledConnection(
  pool: RpcPool,
  connectionFor: (member: RpcPoolMember) => Connection,
  options: PooledConnectionOptions = {},
): Connection {
  const head = pool.transaction[0] ?? pool.read[0];
  if (!head) throw new Error("RPC pool has no providers");
  let stickyEndpoint: string | null = null;
  let preferredKey: string | null = null; // weighted pick for this connection, until a provider serves
  const proxy: Connection = new Proxy(connectionFor(head), {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function" || !managedConnectionMethod(prop)) {
        return value;
      }
      const policy = policyFor(prop);
      const route = effectiveRoute(policy.route ?? "read", options.readOnly);
      return (...args: unknown[]) => {
        const routed = routeMembers(pool, policy.route ?? "read", prop, args, options.readOnly);
        const sticky = pool.sticky && route === "read" && stickyEndpoint !== null
          ? routed.find((member) => member.endpoint === stickyEndpoint)
          : undefined;
        let members = routed;
        if (sticky) {
          members = [sticky, ...routed.filter((member) => member !== sticky)];
        } else if (route === "read" && spreadsReads(pool)) {
          members = weightedReadOrder(routed, { preferredKey });
          preferredKey = members[0]?.key ?? null;
        }
        if (!policy.fallback) members = members.slice(0, 1);
        const byKey = new Map(members.map((member) => [member.key, member]));
        const onServed = (key: string) => {
          const served = byKey.get(key);
          if (pool.sticky && served) stickyEndpoint = served.endpoint;
        };
        const attempts = members.map((member) => attemptFor(
          member,
          () => callOn(connectionFor(member), prop, args),
          route === "read" && member !== sticky,
        ));
        return invokeAcrossProviders({
          method: prop,
          args,
          signal: options.signal,
          retry: options.retry,
          attempts,
          policy,
          onServed,
          retryMinContextSlot: route === "read" && spreadsReads(pool),
        }, proxy).then((result) => result.value);
      };
    },
  });
  return proxy;
}

export type ResilientConnectionOptions = {
  primaryId: RpcMetricId;
  fallbackId: RpcMetricId;
  signal?: AbortSignal;
  retry?: Partial<RetryConfig> | null;
};

/**
 * Two-connection form (primary, optional fallback) with engine 0.1.3 semantics. `rpcConnection()`
 * builds the pool from env instead; this stays for hosts and tests that bring their own connections.
 */
export function createResilientConnection(
  primary: Connection,
  fallback: Connection | null = null,
  options: ResilientConnectionOptions = { primaryId: "solami", fallbackId: "default" },
): Connection {
  const primaryMember = legacyPrimaryMember(options.primaryId, "primary");
  const members = fallback ? [primaryMember, legacyFallbackMember(options.fallbackId, "fallback")] : [primaryMember];
  const pool: RpcPool = { source: "legacy", transaction: members, read: members, sticky: false };
  return createPooledConnection(pool, (member) => (member === primaryMember ? primary : fallback!), {
    signal: options.signal,
    retry: options.retry,
  });
}
