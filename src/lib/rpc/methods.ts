import type { MethodPolicy, RpcErrorKind } from "./types";

const SEND: MethodPolicy = { fallback: false, fallbackOn: [] };

/** Validation (Solami non-compliance), upstream 5xx, 429, and timeouts. */
const FALLBACK_READ: readonly RpcErrorKind[] = ["validation", "http-5xx", "rate-limit", "timeout"];

const READ: MethodPolicy = { fallback: true, fallbackOn: FALLBACK_READ };

/** jsonParsed / epoch shapes Solami often fails; also treat a null tx as empty. */
const PARSED: MethodPolicy = {
  fallback: true,
  fallbackOn: [...FALLBACK_READ, "empty"],
  emptyWhen: (value) => value === null || value === undefined,
};

const EPOCH: MethodPolicy = {
  fallback: true,
  fallbackOn: FALLBACK_READ,
};

/**
 * Per-method routing. Primary is always Solami when configured (account reads
 * and sends stay there). Fallback runs only for listed error kinds, after
 * same-provider retries for 429 / 5xx / timeout.
 *
 * To add a method: one entry here. Do not special-case providers in callers.
 */
export const METHOD_POLICIES: Record<string, MethodPolicy> = {
  sendRawTransaction: SEND,
  sendTransaction: SEND,
  sendEncodedTransaction: SEND,
  confirmTransaction: SEND,
  getEpochInfo: EPOCH,
  getParsedTransaction: PARSED,
  getParsedTransactions: PARSED,
  getTransaction: PARSED,
};

export const DEFAULT_METHOD_POLICY: MethodPolicy = READ;

export function policyFor(method: string): MethodPolicy {
  return METHOD_POLICIES[method] ?? DEFAULT_METHOD_POLICY;
}

export function methodAllowsFallback(method: string, kind: RpcErrorKind): boolean {
  const policy = policyFor(method);
  return policy.fallback && policy.fallbackOn.includes(kind);
}

/** Safe read-only methods and their in-memory TTLs (ms). */
export const CACHE_TTLS: Record<string, number> = {
  getAccountInfo: 5_000,
  getMultipleAccounts: 5_000,
  getMultipleAccountsInfo: 5_000,
  getTokenLargestAccounts: 10_000,
  getParsedTransaction: 60_000,
  getParsedTransactions: 60_000,
  getTransaction: 60_000,
};

/**
 * Blockhash / confirmation / send / simulate — never cache. Slot-sensitive
 * account snapshots used as simulation context are also excluded.
 */
export const UNCACHEABLE_METHODS = new Set([
  "sendRawTransaction",
  "sendTransaction",
  "sendEncodedTransaction",
  "confirmTransaction",
  "simulateTransaction",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignatureStatuses",
  "getSlot",
  "getEpochInfo",
  "getFeeForMessage",
  "getMultipleAccountsInfoAndContext",
]);

function hasProcessedCommitment(args: readonly unknown[]): boolean {
  for (const arg of args) {
    if (arg === "processed") return true;
    if (arg && typeof arg === "object" && "commitment" in arg) {
      if ((arg as { commitment?: string }).commitment === "processed") return true;
    }
  }
  return false;
}

/** TTL in ms, or `null` when the call must not be cached. */
export function cacheTtlFor(method: string, args: readonly unknown[] = []): number | null {
  if (UNCACHEABLE_METHODS.has(method)) return null;
  const ttl = CACHE_TTLS[method];
  if (!ttl) return null;
  if (
    (method === "getParsedTransaction" || method === "getTransaction" || method === "getParsedTransactions")
    && hasProcessedCommitment(args)
  ) {
    return null;
  }
  return ttl;
}
