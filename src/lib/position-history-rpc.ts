import "@/lib/engine-host";
import "server-only";
import { createHash } from "node:crypto";
import type { Connection } from "@solana/web3.js";
import { rpcConnection, defaultRpcConnection, resolveProviderPair, PUBLIC_SOLANA_RPC_URL,
  parseRetryAfter, RpcUnavailableError, type RpcEnv, type RpcProvider, type RetryConfig } from "@sofinance/engine/rpc";

const ACTIVE_LIMIT = 8;
const ENDPOINT_LIMIT = 16;
const QUEUE_LIMIT = 512;
const BODY_LIMIT = 16 * 1024 * 1024;
const HISTORY_METHODS = new Set(["getTransaction", "getSignaturesForAddress", "getSignatureStatuses", "getTransactionsForAddress"]);
export type HistoryRpcMetric = {
  attemptCount: number; rateLimitCount: number; queuedMs: number; requestMs: number;
  /** This observer's active physical attempts, including body consumption. */
  maxActive: number;
  /** Actual Solami leaf attempts; generic/public leaves are counted under defaultAttempts. */
  primaryAttempts: number; defaultAttempts: number;
  /** Decoded response-body bytes actually consumed; not compressed wire/header bytes. */
  responseBytes: number;
};
export type HistoryRpcObserver = { snapshot(): HistoryRpcMetric; receiptProvider(signature: string): RpcProvider | undefined };
export type HistoryRpcOptions = { fetch?: typeof fetch; retry?: Partial<RetryConfig> | null;
  onMetric?: (metric: HistoryRpcMetric) => void };
type Work = { weight: number; signal: AbortSignal; start: (queuedMs: number) => Promise<Response>;
  queuedAt: number; resolve: (value: Response) => void; reject: (reason: unknown) => void; abort: () => void };
const reason = (signal: AbortSignal) => signal.reason ?? new DOMException("History RPC request aborted", "AbortError");

class EndpointQueue {
  active = 0;
  private activeMethods = 0;
  nextStart = 0;
  cooldownUntil = 0;
  touchedAt = Date.now();
  private readonly waiting: Work[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly intervalMs: number) {}
  get idle() { return this.active === 0 && this.waiting.length === 0 && Math.max(this.nextStart, this.cooldownUntil) <= Date.now(); }
  run(signal: AbortSignal, weight: number, start: Work["start"]): Promise<Response> {
    if (signal.aborted) return Promise.reject(reason(signal));
    if (this.waiting.length >= QUEUE_LIMIT) return Promise.reject(new RpcUnavailableError());
    return new Promise((resolve, reject) => {
      const item: Work = { weight, signal, start, queuedAt: Date.now(), resolve, reject, abort: () => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return;
        this.waiting.splice(index, 1); signal.removeEventListener("abort", item.abort);
        reject(reason(signal)); this.pump();
      } };
      signal.addEventListener("abort", item.abort, { once: true });
      this.waiting.push(item); this.pump();
    });
  }
  cooldown(ms: number) { this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms); this.pump(); }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const item of this.waiting.splice(0)) {
      item.signal.removeEventListener("abort", item.abort);
      item.reject(new DOMException("History RPC pacing reset", "AbortError"));
    }
  }
  private pump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.waiting.length || this.active >= ACTIVE_LIMIT || this.activeMethods + this.waiting[0]!.weight > ACTIVE_LIMIT) return;
    const now = Date.now(), delay = Math.max(this.nextStart, this.cooldownUntil) - now;
    if (delay > 0) {
      // Long Retry-After dates retain their cooldown; periodically recheck without timer overflow.
      this.timer = setTimeout(() => this.pump(), Math.min(delay, 50_000));
      return;
    }
    const item = this.waiting.shift()!;
    item.signal.removeEventListener("abort", item.abort);
    if (item.signal.aborted) { item.reject(reason(item.signal)); this.pump(); return; }
    this.active++; this.activeMethods += item.weight; this.touchedAt = now; this.nextStart = now + this.intervalMs * item.weight;
    void Promise.resolve().then(() => item.start(Math.max(0, Date.now() - item.queuedAt)))
      .then(item.resolve, item.reject).finally(() => { this.active--; this.activeMethods -= item.weight; this.touchedAt = Date.now(); this.pump(); });
    this.pump();
  }
}

// Credential-bearing endpoint URLs never leave resolution/transport or appear in metrics.
const endpoints = new Map<string, EndpointQueue>();
function endpointQueue(url: string): EndpointQueue {
  const key = createHash("sha256").update(url).digest("hex");
  const existing = endpoints.get(key);
  if (existing) return existing;
  if (endpoints.size >= ENDPOINT_LIMIT) {
    const oldest = [...endpoints].filter(([, queue]) => queue.idle).sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) throw new RpcUnavailableError();
    oldest[1].dispose(); endpoints.delete(oldest[0]);
  }
  const endpoint = new URL(url), publicEndpoint = new URL(PUBLIC_SOLANA_RPC_URL);
  const isPublic = endpoint.origin === publicEndpoint.origin && endpoint.pathname.replace(/\/$/, "") === publicEndpoint.pathname.replace(/\/$/, "");
  const queue = new EndpointQueue(isPublic ? 250 : 125);
  endpoints.set(key, queue); return queue;
}

/** Clear test-only pacing state; production refresh/invalidation must retain provider cooldowns. */
export function resetHistoryRpcPacingForTests() {
  if ([...endpoints.values()].some(queue => !queue.idle)) throw new RpcUnavailableError();
  for (const queue of endpoints.values()) queue.dispose();
  endpoints.clear();
}

function historyRequest(init?: RequestInit): { signatures: string[]; weight: number } | null {
  if (typeof init?.body !== "string" || init.body.length > 1_000_000) return null;
  try {
    const body = JSON.parse(init.body) as { method?: string; params?: unknown[] } | { method?: string; params?: unknown[] }[];
    const requests = Array.isArray(body) ? body : [body];
    if (!requests.length || requests.some(request => !request.method || !HISTORY_METHODS.has(request.method))) return null;
    if (requests.length > ACTIVE_LIMIT) throw new RpcUnavailableError();
    return { weight: requests.length, signatures: requests.flatMap(request =>
      request.method === "getTransaction" && typeof request.params?.[0] === "string" ? [request.params[0]] : []) };
  } catch (error) { if (error instanceof RpcUnavailableError) throw error; return null; }
}

/** A bounded single body read, then reconstruct for web3.js. Slots stay occupied until consumed. */
async function readBody(response: Response, signal: AbortSignal, observeBytes: (count: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel(reason(signal)).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength; observeBytes(next.value.byteLength);
      if (bytes > BODY_LIMIT) { await reader.cancel(); throw new RpcUnavailableError(); }
      chunks.push(next.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally { signal.removeEventListener("abort", onAbort); reader.releaseLock(); }
}

/** History-only leaf transport: all internal/outer fallback and retry fetches use shared pacing. */
export function createHistoryRpcFetch(signal: AbortSignal, env?: RpcEnv,
  options: HistoryRpcOptions = {}): { fetch: typeof fetch; observer: HistoryRpcObserver } {
  const pair = resolveProviderPair(env);
  const metric: HistoryRpcMetric = { attemptCount: 0, rateLimitCount: 0, queuedMs: 0,
    requestMs: 0, maxActive: 0, primaryAttempts: 0, defaultAttempts: 0, responseBytes: 0 };
  const receipts = new Map<string, RpcProvider>();
  let ownActive = 0;
  const snapshot = () => ({ ...metric });
  const notify = () => { try { options.onMetric?.(snapshot()); } catch { /* Metrics cannot interrupt transport. */ } };
  const observedFetch: typeof fetch = async (input, init) => {
    const request = historyRequest(init);
    if (!request) return (options.fetch ?? fetch)(input, init);
    const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const url = input instanceof Request ? input.url : String(input);
    const queue = endpointQueue(url);
    const provider: RpcProvider = pair.primary.metricId === "solami" && url === pair.primary.endpoint ? "solami" : "default";
    return queue.run(requestSignal, request.weight, async queuedMs => {
      requestSignal.throwIfAborted();
      const started = Date.now(); ownActive++;
      metric.attemptCount++; metric.queuedMs += queuedMs; metric.maxActive = Math.max(metric.maxActive, ownActive);
      if (provider === "solami") metric.primaryAttempts++; else metric.defaultAttempts++;
      notify();
      try {
        const response = await (options.fetch ?? fetch)(input, { ...init, signal: requestSignal });
        if (response.status === 429) {
          metric.rateLimitCount++;
          queue.cooldown(parseRetryAfter(response.headers.get("Retry-After")) ?? 1000);
        }
        const body = await readBody(response, requestSignal, count => { metric.responseBytes += count; });
        if (response.ok && request.signatures.length) {
          try {
            const json = JSON.parse(new TextDecoder().decode(body)) as { result?: { slot?: number;
              transaction?: { signatures?: string[] }; meta?: { err?: unknown; logMessages?: unknown[] } } } | { result?: { slot?: number;
              transaction?: { signatures?: string[] }; meta?: { err?: unknown; logMessages?: unknown[] } } }[];
            for (const candidate of Array.isArray(json) ? json : [json]) {
              const tx = candidate.result, signature = tx?.transaction?.signatures?.[0];
              if (signature && request.signatures.includes(signature) && Number.isSafeInteger(tx?.slot) && tx!.slot! >= 0 &&
                tx?.meta && (Boolean(tx.meta.err) || (Array.isArray(tx.meta.logMessages) && tx.meta.logMessages.length > 0))) {
                receipts.delete(signature); receipts.set(signature, provider);
                if (receipts.size > 500) receipts.delete(receipts.keys().next().value!);
              }
            }
          } catch { /* Raw candidate validation belongs to web3.js and the position parser. */ }
        }
        return new Response([204, 205, 304].includes(response.status) ? null : body,
          { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally { ownActive--; metric.requestMs += Math.max(0, Date.now() - started); notify(); }
    });
  };
  return { fetch: observedFetch, observer: { snapshot, receiptProvider: signature => receipts.get(signature) } };
}

export function createHistoryRpcConnections(signal: AbortSignal, env?: RpcEnv,
  options: HistoryRpcOptions = {}): { connection: Connection; fallbackConnection?: Connection; observer: HistoryRpcObserver } {
  const transport = createHistoryRpcFetch(signal, env, options);
  const init = { signal, env, fetch: transport.fetch, retry: options.retry };
  return { connection: rpcConnection(env, init),
    fallbackConnection: resolveProviderPair(env).primary.metricId === "solami" ? defaultRpcConnection(env, init) : undefined,
    observer: transport.observer };
}
