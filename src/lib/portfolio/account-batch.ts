import "server-only";
import type { AccountInfo, Commitment, Connection, GetAccountInfoConfig, PublicKey } from "@solana/web3.js";

type Account = AccountInfo<Buffer> | null;
type Pending = { key: PublicKey; resolve: (value: Account) => void; reject: (error: unknown) => void };

/** Request-local confirmed account reads: deduplicate shared pools/ticks and coalesce each dependency wave. */
export function batchAccountReads(connection: Connection, signal?: AbortSignal): Connection {
  const cache = new Map<string, Promise<Account>>();
  const groups = new Map<string, Pending[]>();
  const read = (key: PublicKey, config?: Commitment | GetAccountInfoConfig): Promise<Account> => {
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
      queueMicrotask(() => {
        groups.delete(group);
        if (signal?.aborted) { queue.forEach((entry) => entry.reject(signal.reason)); return; }
        // Solana permits at most 100 accounts in one getMultipleAccounts request.
        for (let offset = 0; offset < queue.length; offset += 100) {
          const batch = queue.slice(offset, offset + 100);
          void connection.getMultipleAccountsInfo(batch.map((entry) => entry.key), config).then((values) => {
            if (values.length !== batch.length) throw new Error("Incomplete account batch");
            batch.forEach((entry, index) => entry.resolve(values[index]!));
          }).catch((error: unknown) => batch.forEach((entry) => entry.reject(error)));
        }
      });
    });
    cache.set(identity, promise);
    return promise;
  };
  return new Proxy(connection, {
    get(target, property) {
      if (property === "getAccountInfo") return read;
      if (property === "getMultipleAccountsInfo") return (keys: PublicKey[], config?: Commitment | GetAccountInfoConfig) => Promise.all(keys.map((key) => read(key, config)));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
