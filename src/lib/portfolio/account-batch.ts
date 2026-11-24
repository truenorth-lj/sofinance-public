import "server-only";
import type { AccountInfo, Commitment, Connection, GetAccountInfoConfig, PublicKey } from "@solana/web3.js";
import { classifyRpcError } from "@sofinance/engine/rpc/errors";

type Account = AccountInfo<Buffer> | null;
type Config = Commitment | GetAccountInfoConfig;
type Pending = { key: PublicKey; resolve: (value: Account) => void; reject: (error: unknown) => void };

/** Solana permits at most 100 accounts in one getMultipleAccounts request. */
export const ACCOUNT_BATCH_LIMIT = 100;

/** True when the error, or any error it wraps (`cause`), is a provider rate limit. */
export function isRateLimited(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    if (classifyRpcError(current) === "rate-limit") return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Request-local account reads: deduplicate shared pools/ticks and coalesce each dependency wave into
 * getMultipleAccounts calls of at most 100 keys. The window is one macrotask, so concurrent readers
 * (other rows, other DEXes) whose waves land a few promise hops apart still share a call.
 * A failed or short batch falls back to one getAccountInfo per key, so one bad response never fails every row.
 * A rate-limited batch (HTTP 429 / JSON-RPC -32005, also when wrapped as RpcUnavailableError) does not fan out:
 * one call per key would only add load to a provider that is already refusing; those keys reject and their rows degrade.
 */
export function batchAccountReads(connection: Connection, signal?: AbortSignal): Connection {
  const cache = new Map<string, Promise<Account>>();
  const groups = new Map<string, Pending[]>();
  const single = (entry: Pending, config?: Config) => {
    if (signal?.aborted) { entry.reject(signal.reason); return; }
    Promise.resolve().then(() => connection.getAccountInfo(entry.key, config)).then((value) => entry.resolve(value ?? null), entry.reject);
  };
  const flush = (group: string, queue: Pending[], config?: Config) => {
    groups.delete(group);
    if (signal?.aborted) { queue.forEach((entry) => entry.reject(signal.reason)); return; }
    for (let offset = 0; offset < queue.length; offset += ACCOUNT_BATCH_LIMIT) {
      const batch = queue.slice(offset, offset + ACCOUNT_BATCH_LIMIT);
      Promise.resolve().then(() => connection.getMultipleAccountsInfo(batch.map((entry) => entry.key), config)).then((values) => {
        if (!Array.isArray(values) || values.length !== batch.length) throw new Error("Incomplete account batch");
        batch.forEach((entry, index) => entry.resolve(values[index] ?? null));
      }).catch((error: unknown) => batch.forEach((entry) => isRateLimited(error) ? entry.reject(error) : single(entry, config)));
    }
  };
  const read = (key: PublicKey, config?: Config): Promise<Account> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const group = JSON.stringify(config ?? null);
    const identity = `${group}:${key.toBase58()}`;
    const cached = cache.get(identity);
    if (cached) return cached;
    const promise = new Promise<Account>((resolve, reject) => {
      const pending = groups.get(group);
      const item = { key, resolve, reject };
      if (pending) { pending.push(item); return; }
      const queue = [item];
      groups.set(group, queue);
      setImmediate(() => flush(group, queue, config));
    });
    // A failed read is not remembered: a later wave (or row) may retry it.
    promise.catch(() => { if (cache.get(identity) === promise) cache.delete(identity); });
    cache.set(identity, promise);
    return promise;
  };
  return new Proxy(connection, {
    get(target, property) {
      if (property === "getAccountInfo") return read;
      if (property === "getMultipleAccountsInfo") return (keys: PublicKey[], config?: Config) => Promise.all(keys.map((key) => read(key, config)));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * `connection` with its account reads served by a shared request batch. Every other method (history,
 * signatures, transactions) stays on `connection`; a row deadline still rejects the row's account waits.
 */
export function withSharedAccountReads(accounts: Connection, connection: Connection, signal?: AbortSignal): Connection {
  const bounded = <T>(work: Promise<T>): Promise<T> => !signal ? work : new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
  return new Proxy(connection, {
    get(target, property) {
      if (property === "getAccountInfo") return (key: PublicKey, config?: Config) => bounded(accounts.getAccountInfo(key, config));
      if (property === "getMultipleAccountsInfo") return (keys: PublicKey[], config?: Config) => bounded(accounts.getMultipleAccountsInfo(keys, config));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
