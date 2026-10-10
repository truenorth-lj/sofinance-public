import type { MethodPolicy, RpcErrorKind } from "./types";

const SEND: MethodPolicy = { fallback: false, fallbackOn: [] };

/** Non-compliant JSON (Superstruct) and upstream 5xx. 429 stays on primary. */
const READ: MethodPolicy = { fallback: true, fallbackOn: ["validation", "http-5xx"] };

/** jsonParsed / epoch shapes Solami often fails; also treat a null tx as empty. */
const PARSED: MethodPolicy = {
  fallback: true,
  fallbackOn: ["validation", "http-5xx", "empty"],
  emptyWhen: (value) => value === null || value === undefined,
};

const EPOCH: MethodPolicy = {
  fallback: true,
  fallbackOn: ["validation", "http-5xx"],
};

/**
 * Per-method routing. Primary is always Solami when configured (account reads
 * and sends stay there). Fallback runs only for listed error kinds.
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
