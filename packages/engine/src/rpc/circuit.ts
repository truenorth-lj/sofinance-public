import type { RpcErrorKind } from "./types";

/**
 * Circuits are keyed per provider: the legacy primary uses its metric id (`solami` / `default`, shared
 * with history listing as before), pool providers use their configured name.
 *
 * Short process-local breaker so a dead primary (expired key, lapsed plan,
 * sustained 429 / 5xx) is not retried on every RPC. Cooldowns stay small so a
 * rotated key or recovered upstream is picked up without a restart.
 */
export type RpcCircuitConfig = {
  authCooldownMs: number;
  rateLimitCooldownMs: number;
  transientFailureThreshold: number;
  transientCooldownMs: number;
};

export const DEFAULT_CIRCUIT: RpcCircuitConfig = {
  authCooldownMs: 30_000,
  // Short: while open, reads go to the public fallback, which itself limits shared server IPs hard.
  rateLimitCooldownMs: 2_000,
  transientFailureThreshold: 2,
  transientCooldownMs: 10_000,
};

type CircuitState = {
  openUntil: number;
  consecutiveFailures: number;
  lastKind?: RpcErrorKind;
};

const circuits = new Map<string, CircuitState>();
let config: RpcCircuitConfig = { ...DEFAULT_CIRCUIT };
let nowFn = () => Date.now();

export function setRpcCircuitConfig(next: Partial<RpcCircuitConfig> | null): void {
  config = next === null ? { ...DEFAULT_CIRCUIT } : { ...DEFAULT_CIRCUIT, ...next };
}

export function setRpcCircuitClock(next: (() => number) | null): void {
  nowFn = next ?? (() => Date.now());
}

export function resetRpcCircuit(): void {
  circuits.clear();
  config = { ...DEFAULT_CIRCUIT };
  nowFn = () => Date.now();
}

export function isPrimaryCircuitOpen(id: string): boolean {
  const state = circuits.get(id);
  if (!state) return false;
  return state.openUntil > nowFn();
}

export function circuitErrorKind(id: string): RpcErrorKind | undefined {
  return circuits.get(id)?.lastKind;
}

function stateOf(id: string): CircuitState {
  const existing = circuits.get(id);
  if (existing) return existing;
  const created: CircuitState = { openUntil: 0, consecutiveFailures: 0 };
  circuits.set(id, created);
  return created;
}

function openFor(state: CircuitState, cooldownMs: number, kind: RpcErrorKind) {
  state.openUntil = Math.max(state.openUntil, nowFn() + Math.max(0, cooldownMs));
  state.lastKind = kind;
}

export function notePrimarySuccess(id: string): void {
  const state = circuits.get(id);
  if (!state) return;
  state.consecutiveFailures = 0;
  state.openUntil = 0;
  state.lastKind = undefined;
}

/**
 * `maxRateLimitCooldownMs` caps how long a 429 (or its Retry-After) keeps the circuit open. The legacy
 * pair uses `rateLimitCooldownMs` (short, because the only alternative is the public RPC); pool
 * providers pass a longer cap so a provider asking for a pause gets it while others serve.
 */
export function notePrimaryFailure(
  id: string,
  kind: RpcErrorKind,
  retryAfterMs: number | null = null,
  maxRateLimitCooldownMs: number | null = null,
): void {
  const state = stateOf(id);
  state.lastKind = kind;
  if (kind === "auth") {
    state.consecutiveFailures += 1;
    openFor(state, config.authCooldownMs, kind);
    return;
  }
  if (kind === "rate-limit") {
    state.consecutiveFailures += 1;
    const hinted = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : config.rateLimitCooldownMs;
    openFor(state, Math.min(hinted, maxRateLimitCooldownMs ?? config.rateLimitCooldownMs), kind);
    return;
  }
  if (kind === "http-5xx" || kind === "timeout") {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= config.transientFailureThreshold) {
      openFor(state, config.transientCooldownMs, kind);
    }
  }
}

export function rpcCircuitConfig(): RpcCircuitConfig {
  return config;
}
