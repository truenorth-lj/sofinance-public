import "server-only";
import { POSITION_HISTORY_PARSER_VERSION, PositionHistoryStoreError } from "./position-history-store-types";
import { syncPositionHistory, type SyncPositionHistoryOptions, type SyncedPositionHistory } from "./position-history-sync";

const TTL_MS = 8_000;
const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const LOAD_DEADLINE_MS = 50_000;
export type CachedPositionHistoryOptions = SyncPositionHistoryOptions & {
  bypassCache?: boolean; stateFingerprint?: string; parserVersion?: number;
};
type Loader = (options: SyncPositionHistoryOptions) => Promise<SyncedPositionHistory>;
type Entry = { positionMint: string; value: SyncedPositionHistory; syncedAt: number; bytes: number };
type Flight = { positionMint: string; controller: AbortController; promise: Promise<SyncedPositionHistory>;
  invalidated: boolean; settled: boolean; waiters: number; syncedAt: number };
const invalidated = () => new PositionHistoryStoreError("POSITION_HISTORY_CACHE_INVALIDATED");
const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException("Position history request aborted", "AbortError");

/** An eight-second history-only cache; current balances, fees and prices stay outside it. */
export class PositionHistoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Flight>();
  private readonly stores = new WeakMap<object, number>();
  private storeSequence = 0;
  private bytes = 0;
  private readonly clock: () => number;
  constructor(options: { clock?: () => number } = {}) { this.clock = options.clock ?? Date.now; }

  get(options: CachedPositionHistoryOptions, loader: Loader = syncPositionHistory): Promise<SyncedPositionHistory> {
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    const started = this.clock();
    if (options.bypassCache) this.invalidate(options.context.positionMint);
    this.prune();
    const key = this.key(options);
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key); this.entries.set(key, entry);
      return Promise.resolve(this.output(entry.value, started, entry.syncedAt, true));
    }
    let flight = this.inflight.get(key);
    if (!flight) {
      const controller = new AbortController();
      let rejectShared!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectShared = reject; });
      const onAbort = () => rejectShared(abortReason(controller.signal));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new DOMException("Position history sync timed out", "TimeoutError")), LOAD_DEADLINE_MS);
      const work = Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return loader({ ...options, signal: controller.signal });
      }), aborted]).then(value => {
        if (flight!.invalidated || this.inflight.get(key) !== flight) throw invalidated();
        flight!.syncedAt = this.clock();
        const saved = structuredClone(value);
        if (!saved.truncated && saved.metric.historyComplete === true) this.remember(key, {
          positionMint: options.context.positionMint, value: saved, syncedAt: flight!.syncedAt,
          bytes: Buffer.byteLength(JSON.stringify(saved)),
        });
        return saved;
      }).finally(() => {
        clearTimeout(timeout); controller.signal.removeEventListener("abort", onAbort);
        flight!.settled = true;
        this.removeSettledFlight(key, flight!);
      });
      flight = { positionMint: options.context.positionMint, controller, promise: work,
        invalidated: false, settled: false, waiters: 0, syncedAt: started };
      this.inflight.set(key, flight);
    }
    return this.wait(key, flight, options.signal, started);
  }

  invalidate(positionMint: string): void {
    for (const [key, entry] of this.entries) if (entry.positionMint === positionMint) this.removeEntry(key);
    for (const [key, flight] of this.inflight) if (flight.positionMint === positionMint) {
      flight.invalidated = true;
      this.inflight.delete(key);
      flight.controller.abort(invalidated());
    }
  }

  reset(): void {
    for (const flight of this.inflight.values()) {
      flight.invalidated = true; flight.controller.abort(invalidated());
    }
    this.inflight.clear(); this.entries.clear(); this.bytes = 0;
  }

  private key(options: CachedPositionHistoryOptions): string {
    let storeId = this.stores.get(options.store);
    if (storeId === undefined) { storeId = ++this.storeSequence; this.stores.set(options.store, storeId); }
    const c = options.context;
    return JSON.stringify([storeId, options.parserVersion ?? POSITION_HISTORY_PARSER_VERSION,
      Math.min(500, Math.max(1, Math.floor(options.maxSignatures) || 100)), options.stateFingerprint ?? null,
      Math.min(500, Math.max(1, Math.floor(options.maxDetailRequests ?? 500) || 1)),
      c.positionMint, c.positionAccount, c.poolId, c.mintA, c.mintB, c.vaultA, c.vaultB]);
  }

  private output(value: SyncedPositionHistory, started: number, syncedAt: number, hit: boolean): SyncedPositionHistory {
    const result = structuredClone(value);
    const metric = { ...result.metric, elapsedMs: Math.max(0, this.clock() - started),
      memoryCacheHit: hit, memoryCacheAgeMs: hit ? Math.max(0, this.clock() - syncedAt) : 0,
      historySyncedAt: new Date(syncedAt).toISOString(),
      ...(hit ? { fetchedTxCount: 0, listingCount: 0, solamiTxCount: 0, defaultTxCount: 0,
        cachedTxCount: result.signatureCount, fallbackReasons: [],
        ...(result.metric.unattributedTxCount !== undefined ? { unattributedTxCount: 0 } : {}),
        ...(result.metric.stages ? { stages: { claimMs: 0, listingMs: 0, detailsMs: 0,
          parseMs: 0, commitMs: 0, releaseMs: 0 } } : {}),
        ...(result.metric.rpc ? { rpc: { attemptCount: 0, rateLimitCount: 0, queuedMs: 0,
          requestMs: 0, maxActive: 0, primaryAttempts: 0, defaultAttempts: 0, responseBytes: 0 } } : {}) } : {}) };
    result.metric = metric;
    return result;
  }

  private wait(key: string, flight: Flight, signal: AbortSignal | undefined, started: number): Promise<SyncedPositionHistory> {
    flight.waiters++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (callback: () => void) => {
        if (done) return;
        done = true; signal?.removeEventListener("abort", onAbort);
        flight.waiters--;
        if (!flight.waiters && !flight.settled) {
          flight.invalidated = true;
          if (this.inflight.get(key) === flight) this.inflight.delete(key);
          flight.controller.abort(signal?.reason ?? new DOMException("All position history viewers left", "AbortError"));
        }
        this.removeSettledFlight(key, flight);
        callback();
      };
      const onAbort = () => finish(() => reject(abortReason(signal!)));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      flight.promise.then(value => finish(() => {
        if (flight.invalidated) reject(invalidated());
        else resolve(this.output(value, started, flight.syncedAt, false));
      }), error => finish(() => reject(error)));
    });
  }

  private removeSettledFlight(key: string, flight: Flight): void {
    if (flight.settled && !flight.waiters && this.inflight.get(key) === flight) this.inflight.delete(key);
  }
  private prune(): void {
    for (const [key, entry] of this.entries) if (this.clock() - entry.syncedAt >= TTL_MS) this.removeEntry(key);
  }
  private removeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  private remember(key: string, entry: Entry): void {
    if (entry.bytes > MAX_BYTES) return;
    this.removeEntry(key); this.entries.set(key, entry); this.bytes += entry.bytes;
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) this.removeEntry(this.entries.keys().next().value!);
  }
}

const positionHistoryCache = new PositionHistoryCache();
export const cachedSyncPositionHistory = (options: CachedPositionHistoryOptions, loader?: Loader) => positionHistoryCache.get(options, loader);
export const invalidatePositionHistoryCache = (positionMint: string) => positionHistoryCache.invalidate(positionMint);
export const resetPositionHistoryCache = () => positionHistoryCache.reset();
