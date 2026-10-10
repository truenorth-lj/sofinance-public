export type RpcCacheEntry = {
  value: unknown;
  expiresAt: number;
};

/**
 * Best-effort read cache. The default is a per-instance memory map (Vercel
 * Hobby / serverless). Swap in a shared store by implementing this interface.
 */
export interface RpcCacheStore {
  get(key: string): RpcCacheEntry | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  clear(): void;
  readonly size: number;
}

export class MemoryRpcCache implements RpcCacheStore {
  private readonly entries = new Map<string, RpcCacheEntry>();

  constructor(
    private readonly maxEntries = 256,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): RpcCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

let store: RpcCacheStore = new MemoryRpcCache();
const inflight = new Map<string, Promise<unknown>>();

export function getRpcCache(): RpcCacheStore {
  return store;
}

export function setRpcCache(next: RpcCacheStore | null): void {
  store = next ?? new MemoryRpcCache();
}

export function resetRpcCache(): void {
  store.clear();
  inflight.clear();
}

export function cacheKeyFor(method: string, args: readonly unknown[]): string {
  return `${method}:${JSON.stringify(args, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object" && typeof (value as { toBase58?: unknown }).toBase58 === "function") {
      return (value as { toBase58: () => string }).toBase58();
    }
    return value;
  })}`;
}

export async function withCacheAndInflight<T>(
  key: string | null,
  ttlMs: number | null,
  run: () => Promise<T>,
): Promise<{ value: T; cacheHit: boolean }> {
  if (!key || ttlMs == null) {
    return { value: await run(), cacheHit: false };
  }
  const cached = store.get(key);
  if (cached) return { value: cached.value as T, cacheHit: true };
  const existing = inflight.get(key);
  if (existing) return { value: await (existing as Promise<T>), cacheHit: false };
  const pending = run().then((value) => {
    store.set(key, value, ttlMs);
    return value;
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pending);
  return { value: await pending, cacheHit: false };
}
