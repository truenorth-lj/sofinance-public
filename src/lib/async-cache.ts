/**
 * Small per-instance async cache: TTL, in-flight de-duplication and a short negative cache so a
 * failing upstream is not hammered by every caller. Safe for module-level singletons.
 */
export type AsyncCacheOptions = {
  ttlMs: number;
  /** How long a failure is remembered and re-thrown without calling the loader again. Default 0 (off). */
  failureTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

type Settled<T> = { at: number; ttl: number; value: T } | { at: number; ttl: number; error: unknown };

export class AsyncCache<T> {
  private readonly settled = new Map<string, Settled<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: AsyncCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.failureTtlMs = options.failureTtlMs ?? 0;
    this.maxEntries = options.maxEntries ?? 64;
    this.now = options.now ?? (() => Date.now());
  }

  /** Cached value, or the in-flight promise, or a fresh `load()`; concurrent callers share one load. */
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.settled.get(key);
    if (hit && this.now() - hit.at < hit.ttl) {
      return "error" in hit ? Promise.reject(hit.error) : Promise.resolve(hit.value);
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const work = (async () => {
      try {
        const value = await load();
        this.remember(key, { at: this.now(), ttl: this.ttlMs, value });
        return value;
      } catch (error) {
        if (this.failureTtlMs > 0) this.remember(key, { at: this.now(), ttl: this.failureTtlMs, error });
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, work);
    return work;
  }

  clear(): void {
    this.settled.clear();
    this.inflight.clear();
  }

  private remember(key: string, entry: Settled<T>) {
    this.settled.delete(key);
    this.settled.set(key, entry);
    while (this.settled.size > this.maxEntries) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }
}
