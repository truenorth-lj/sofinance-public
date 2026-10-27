import type { MethodPolicy, RpcErrorKind, RpcRoute } from "./types";

/**
 * Re-broadcasting the same signed tx on the fallback is idempotent by
 * signature. Confirm looks up that signature on whichever RPC is healthy.
 */
const SEND: MethodPolicy = {
  fallback: true,
  fallbackOn: ["auth", "rate-limit", "http-5xx", "timeout"],
  route: "transaction",
};

/** Validation, 5xx, 429 / -32005, timeouts, and expired-key / lapsed-plan 401–403. */
const FALLBACK_READ: readonly RpcErrorKind[] = ["validation", "http-5xx", "rate-limit", "timeout", "auth"];

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
 * Simulate / blockhash / height / fee / slot-context reads. Fail over on
 * auth, rate-limit, timeout, validation, and 5xx so a lapsed Solami plan
 * does not stall prepare/confirm. Ordinary 400s stay on the primary.
 */
const PRIMARY_STAY_FALLBACK_ON: readonly RpcErrorKind[] = ["validation", "http-5xx", "auth", "rate-limit", "timeout"];
const PRIMARY_STAY: MethodPolicy = { fallback: true, fallbackOn: PRIMARY_STAY_FALLBACK_ON, route: "transaction" };

/** Same failover as PRIMARY_STAY; the returned slot is later used as a simulation's `minContextSlot`. */
const SLOT_CONTEXT: MethodPolicy = { fallback: true, fallbackOn: PRIMARY_STAY_FALLBACK_ON, route: "context" };

/**
 * Per-method routing. Primary is Solami when configured. Fallback runs only
 * for listed error kinds, after same-provider retries for 429 / 5xx / timeout.
 * Auth (401/402/403) skips same-provider retry and fails over immediately.
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
  simulateTransaction: PRIMARY_STAY,
  getLatestBlockhash: PRIMARY_STAY,
  getBlockHeight: PRIMARY_STAY,
  getFeeForMessage: PRIMARY_STAY,
  getMultipleAccountsInfoAndContext: SLOT_CONTEXT,
  getSlot: SLOT_CONTEXT,
};

export const DEFAULT_METHOD_POLICY: MethodPolicy = READ;

export function policyFor(method: string): MethodPolicy {
  return METHOD_POLICIES[method] ?? DEFAULT_METHOD_POLICY;
}

export function routeFor(method: string): RpcRoute {
  return policyFor(method).route ?? "read";
}

/**
 * JSON-RPC method a web3.js `Connection` method sends, so provider exclusions can be written in
 * JSON-RPC terms (`getProgramAccounts` also covers `getParsedProgramAccounts`). Unlisted names are
 * their own JSON-RPC method.
 */
const WEB3_TO_JSON_RPC: Record<string, string> = {
  getParsedProgramAccounts: "getProgramAccounts",
  getParsedAccountInfo: "getAccountInfo",
  getAccountInfoAndContext: "getAccountInfo",
  getMultipleAccountsInfo: "getMultipleAccounts",
  getMultipleParsedAccounts: "getMultipleAccounts",
  getMultipleAccountsInfoAndContext: "getMultipleAccounts",
  getParsedTransaction: "getTransaction",
  getParsedTransactions: "getTransaction",
  getTransactions: "getTransaction",
  getParsedTokenAccountsByOwner: "getTokenAccountsByOwner",
  confirmTransaction: "getSignatureStatuses",
  sendRawTransaction: "sendTransaction",
  sendEncodedTransaction: "sendTransaction",
};

/** `_rpcRequest(method, params)` carries the JSON-RPC method as its first argument. */
export function jsonRpcMethodOf(method: string, args: readonly unknown[] = []): string {
  if (method === "_rpcRequest" && typeof args[0] === "string") return args[0];
  return WEB3_TO_JSON_RPC[method] ?? method;
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
