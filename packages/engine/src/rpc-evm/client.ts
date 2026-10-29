import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { robinhoodChain } from "../chains/robinhood";
import { engineEnv } from "../host";
import { TokenBucket } from "../rpc/rate-limit";
import { resolveEvmProviders, type EvmRpcProviderId, type EvmRpcRoute, type ResolvedEvmProvider } from "./providers";

/** Thrown (and skipped by the fallback) when a provider's local budget is spent or its cooldown is active. */
export class EvmRpcQuotaError extends Error {
  constructor(readonly provider: EvmRpcProviderId) {
    super(`Local RPC budget exhausted for ${provider}`);
    this.name = "EvmRpcQuotaError";
  }
}

export type EvmRpcEvent = { route: EvmRpcRoute; provider: EvmRpcProviderId; method: string; outcome: "ok" | "error" | "quota" };

type Guard = { bucket: TokenBucket; cooldownUntil: number };
const guards = new Map<string, Guard>();
const RATE_LIMIT_COOLDOWN_MS = 30_000;

function guardFor(route: EvmRpcRoute, provider: ResolvedEvmProvider, now: () => number): Guard {
  const key = `${route}:${provider.id}`;
  const existing = guards.get(key);
  if (existing) return existing;
  const created = { bucket: new TokenBucket(provider.rps, provider.burst, now), cooldownUntil: 0 };
  guards.set(key, created);
  return created;
}

/** Test hook: forget local budgets and cooldowns. */
export function resetEvmRpcGuards(): void {
  guards.clear();
}

const isRateLimited = (error: unknown) => {
  const text = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : String(error);
  return /\b429\b|rate limit|too many requests/i.test(text);
};

export type RhcClientOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected HTTP transport factory (tests use a mock EIP-1193 transport per provider). */
  transportFor?: (provider: ResolvedEvmProvider, route: EvmRpcRoute) => Transport;
  onEvent?: (event: EvmRpcEvent) => void;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * Wraps one provider's transport with its local token bucket and a 429 cooldown. A spent budget
 * throws `EvmRpcQuotaError`, which viem's `fallback` treats as a failure and moves to the next
 * provider instead of sending (so we overflow rather than earn a 429).
 */
function guarded(route: EvmRpcRoute, provider: ResolvedEvmProvider, inner: Transport, options: RhcClientOptions): Transport {
  const now = options.now ?? (() => Date.now());
  return (config) => {
    const base = inner({ ...config, retryCount: 0 });
    const guard = guardFor(route, provider, now);
    return {
      ...base,
      request: (async (args: { method: string; params?: unknown }) => {
        if (guard.cooldownUntil > now() || !guard.bucket.tryTake()) {
          options.onEvent?.({ route, provider: provider.id, method: args.method, outcome: "quota" });
          throw new EvmRpcQuotaError(provider.id);
        }
        try {
          const result = await base.request(args as never);
          options.onEvent?.({ route, provider: provider.id, method: args.method, outcome: "ok" });
          return result;
        } catch (error) {
          if (isRateLimited(error)) guard.cooldownUntil = now() + RATE_LIMIT_COOLDOWN_MS;
          options.onEvent?.({ route, provider: provider.id, method: args.method, outcome: "error" });
          throw error;
        }
      }) as typeof base.request,
    };
  };
}

/** Read-only viem client for one route: `fallback([...providers])` in catalog order (no ranking). */
export function createRhcClient(route: EvmRpcRoute, options: RhcClientOptions = {}): PublicClient {
  const providers = resolveEvmProviders(route, options.env ?? engineEnv());
  if (providers.length === 0) throw new Error(`No Robinhood Chain RPC provider for route ${route}`);
  const timeout = options.timeoutMs ?? 10_000;
  const transports = providers.map(provider => guarded(route, provider,
    options.transportFor?.(provider, route) ?? http(provider.url, { timeout, retryCount: 0, batch: false }), options));
  return createPublicClient({
    chain: robinhoodChain,
    transport: fallback(transports, { rank: false, retryCount: 0 }),
    batch: { multicall: false },
  }) as PublicClient;
}

export type RhcClients = { state: PublicClient; logs: PublicClient };

export function createRhcClients(options: RhcClientOptions = {}): RhcClients {
  return { state: createRhcClient("state", options), logs: createRhcClient("logs", options) };
}
