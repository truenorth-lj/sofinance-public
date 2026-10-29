import { engineEnv } from "../host";
import { jsonRpcMethodOf } from "./methods";
import { resolveProviderPair } from "./providers";
import { isRetiredRpcEndpoint } from "./urls";
import type { RpcEnv, RpcMetricId, RpcRoute } from "./types";

/** Concurrency cap of the legacy primary (unchanged from engine 0.1.3). */
export const PRIMARY_RPC_CONCURRENCY = 6;

/** Longest a 429 / Retry-After parks a pool provider (the legacy pair keeps its 2 s cap). */
export const POOL_RATE_LIMIT_MAX_COOLDOWN_MS = 30_000;

/** One RPC endpoint the router may use. Only `endpoint` is secret; nothing else is. */
export type RpcPoolMember = {
  /** Circuit, rate-limiter, and concurrency key. */
  key: string;
  /** Log label from SOLANA_RPC_PROVIDERS; undefined for the legacy pair (logs stay as before). */
  name?: string;
  metricId: RpcMetricId;
  endpoint: string;
  /** Client-side requests per second; null = no local limit. */
  rps: number | null;
  burst: number | null;
  /** Max in-flight requests from this process; null = unlimited. */
  maxConcurrency: number | null;
  /** When false, failures never open this member's circuit (legacy fallback). */
  trackHealth: boolean;
  /** Cap for a 429's circuit cooldown; null = the circuit default (2 s). */
  rateLimitMaxCooldownMs: number | null;
  /** JSON-RPC methods this provider must not receive (e.g. getProgramAccounts on a free tier). */
  excludeMethods: readonly string[];
};

export type RpcPool = {
  /** `legacy`: SOLANA_RPC_URL only. `env`: SOLANA_RPC_PROVIDERS. */
  source: "legacy" | "env";
  /** Send / simulate / blockhash / confirm (and slot-context reads), tried strictly in order. */
  transaction: readonly RpcPoolMember[];
  /** Everything else; the first healthy provider with budget serves, overflow goes down the list. */
  read: readonly RpcPoolMember[];
  /** Reads on one connection prefer the provider that served its previous call. */
  sticky: boolean;
};

/** One entry of SOLANA_RPC_PROVIDERS. */
export type RpcProviderEntry = {
  name: string;
  /** Literal URL, or `$VAR` to read another env var (e.g. `$SOLANA_RPC_URL`). */
  url: string;
  rps?: number;
  burst?: number;
  maxConcurrency?: number;
  /** May serve send / simulate / blockhash / confirm. Default false. */
  transactions?: boolean;
  /** Serves ordinary reads. Default true. */
  reads?: boolean;
  /** JSON-RPC methods to never send here. */
  exclude?: string[];
};

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export class RpcPoolConfigError extends Error {
  constructor(message: string) {
    super(`SOLANA_RPC_PROVIDERS: ${message}`);
    this.name = "RpcPoolConfigError";
  }
}

/** The legacy primary: concurrency-capped, circuit keyed by metric id (shared with history listing). */
export function legacyPrimaryMember(metricId: RpcMetricId, endpoint: string): RpcPoolMember {
  return {
    key: metricId,
    metricId,
    endpoint,
    rps: null,
    burst: null,
    maxConcurrency: PRIMARY_RPC_CONCURRENCY,
    trackHealth: true,
    rateLimitMaxCooldownMs: null,
    excludeMethods: [],
  };
}

/** The legacy fallback: uncapped, and its failures never open a circuit (last resort, always tried). */
export function legacyFallbackMember(metricId: RpcMetricId, endpoint: string): RpcPoolMember {
  return {
    key: `${metricId}:fallback`,
    metricId,
    endpoint,
    rps: null,
    burst: null,
    maxConcurrency: null,
    trackHealth: false,
    rateLimitMaxCooldownMs: null,
    excludeMethods: [],
  };
}

function legacyPairMembers(env: RpcEnv): RpcPoolMember[] {
  const pair = resolveProviderPair(env);
  const primary = legacyPrimaryMember(pair.primary.metricId, pair.primary.endpoint);
  if (!pair.fallback) return [primary];
  return [primary, legacyFallbackMember(pair.fallback.metricId, pair.fallback.endpoint)];
}

function positive(value: unknown, field: string, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RpcPoolConfigError(`provider "${name}": ${field} must be a positive number`);
  }
  return value;
}

function resolveUrl(url: string, env: RpcEnv): { endpoint: string | null; metricId: RpcMetricId } {
  const endpoint = url.startsWith("$") ? env[url.slice(1)]?.trim() || null : url.trim();
  // A retired vendor URL (literal or via `$VAR`) is skipped like an unset `$VAR`.
  if (endpoint && isRetiredRpcEndpoint(endpoint)) return { endpoint: null, metricId: "default" };
  return { endpoint, metricId: "default" };
}

function toMember(entry: RpcProviderEntry, env: RpcEnv): RpcPoolMember | null {
  const name = entry?.name;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new RpcPoolConfigError("each provider needs a short name (letters, digits, - or _)");
  }
  if (typeof entry.url !== "string" || !entry.url.trim()) throw new RpcPoolConfigError(`provider "${name}": url is required`);
  if (entry.exclude !== undefined && (!Array.isArray(entry.exclude) || entry.exclude.some((m) => typeof m !== "string"))) {
    throw new RpcPoolConfigError(`provider "${name}": exclude must be a list of JSON-RPC method names`);
  }
  const resolved = resolveUrl(entry.url, env);
  if (!resolved.endpoint) return null; // `$VAR` not set in this environment: skip the provider.
  if (!/^https?:\/\//i.test(resolved.endpoint)) throw new RpcPoolConfigError(`provider "${name}": url must be http(s)`);
  return {
    key: `pool:${name}`,
    name,
    metricId: resolved.metricId,
    endpoint: resolved.endpoint,
    rps: positive(entry.rps, "rps", name),
    burst: positive(entry.burst, "burst", name),
    maxConcurrency: positive(entry.maxConcurrency, "maxConcurrency", name),
    trackHealth: true,
    rateLimitMaxCooldownMs: POOL_RATE_LIMIT_MAX_COOLDOWN_MS,
    excludeMethods: entry.exclude ?? [],
  };
}

/** Parses SOLANA_RPC_PROVIDERS (a JSON array). Throws RpcPoolConfigError; messages never include URLs. */
export function parseRpcProviders(raw: string, env: RpcEnv): RpcPool {
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new RpcPoolConfigError("must be a JSON array of providers");
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new RpcPoolConfigError("must be a non-empty JSON array");
  const typed = entries as RpcProviderEntry[];
  const seen = new Set<string>();
  const read: RpcPoolMember[] = [];
  const transaction: RpcPoolMember[] = [];
  for (const entry of typed) {
    const member = toMember(entry, env);
    if (seen.has(entry.name)) throw new RpcPoolConfigError(`duplicate provider name "${entry.name}"`);
    seen.add(entry.name);
    if (!member) continue;
    if (entry.reads !== false) read.push(member);
    if (entry.transactions === true) transaction.push(member);
  }
  if (read.length === 0) throw new RpcPoolConfigError("no read provider resolved (check the $VAR references)");
  return {
    source: "env",
    read,
    // Without an explicit transactions provider, sends keep today's SOLANA_RPC_URL → public pair.
    transaction: transaction.length > 0 ? transaction : legacyPairMembers(env),
    sticky: true,
  };
}

let warnedFor: string | null = null;

/**
 * The provider pool for this environment.
 * - SOLANA_RPC_PROVIDERS unset: exactly the pre-pool behaviour (SOLANA_RPC_URL →
 *   public, primary + one fallback, no local rate limit, no stickiness).
 * - Set and valid: the listed providers. Invalid: logs one key-free error and uses the legacy pool, so a
 *   typo never takes RPC down.
 */
export function resolveRpcPool(env: RpcEnv = engineEnv() as RpcEnv): RpcPool {
  const raw = env.SOLANA_RPC_PROVIDERS?.trim();
  const legacy = (): RpcPool => {
    const members = legacyPairMembers(env);
    return { source: "legacy", transaction: members, read: members, sticky: false };
  };
  if (!raw) return legacy();
  try {
    return parseRpcProviders(raw, env);
  } catch (error) {
    if (warnedFor !== raw) {
      warnedFor = raw;
      // eslint-disable-next-line no-console -- config errors never include URLs or keys
      console.error(JSON.stringify({ rpc: true, config: "invalid", message: (error as Error).message }));
    }
    return legacy();
  }
}

/** Whether `member` may receive JSON-RPC `rpcMethod`. */
export function memberSupports(member: RpcPoolMember, rpcMethod: string): boolean {
  return !member.excludeMethods.includes(rpcMethod);
}

/**
 * Ordered providers for one call. `context` calls follow the transaction providers unless the
 * connection is read-only. Providers that exclude the method are dropped; if none is left the full
 * route is kept so the call fails with the provider's own error instead of silently never running.
 */
export function effectiveRoute(route: RpcRoute, readOnly = false): "transaction" | "read" {
  return route === "context" ? (readOnly ? "read" : "transaction") : route;
}

export function routeMembers(
  pool: RpcPool,
  route: RpcRoute,
  method: string,
  args: readonly unknown[] = [],
  readOnly = false,
): readonly RpcPoolMember[] {
  const effective = effectiveRoute(route, readOnly);
  const members = effective === "transaction" ? pool.transaction : pool.read;
  if (pool.source === "legacy") return members; // Unchanged pre-pool routing.
  const rpcMethod = jsonRpcMethodOf(method, args);
  const supported = members.filter((member) => memberSupports(member, rpcMethod));
  return supported.length > 0 ? supported : members;
}
