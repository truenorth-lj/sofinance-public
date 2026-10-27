import { MemoryRpcCache, type RpcCacheStore } from "../rpc/cache";

let store: RpcCacheStore = new MemoryRpcCache();
const inflight = new Map<string, Promise<unknown>>();

export function getJupiterCache(): RpcCacheStore {
  return store;
}

export function setJupiterCache(next: RpcCacheStore | null): void {
  store = next ?? new MemoryRpcCache();
}

export function resetJupiterCache(): void {
  store.clear();
  inflight.clear();
}

export async function withJupiterCache<T>(
  key: string | null,
  ttlMs: number | null,
  run: () => Promise<T>,
): Promise<{ value: T; cacheHit: boolean }> {
  if (!key || ttlMs === null || ttlMs === undefined) {
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

export function quoteCacheKey(input: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  maxAccounts?: number;
  onlyDirectRoutes?: boolean;
}): string {
  return [
    "quote",
    input.inputMint,
    input.outputMint,
    input.amount,
    String(input.slippageBps),
    input.maxAccounts ?? "",
    input.onlyDirectRoutes ? "1" : "0",
  ].join(":");
}
