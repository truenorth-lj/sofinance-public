import bs58 from "bs58";

export type ObsoleteAttempt = { key: string; signature: string; lastValidBlockHeight: number };

// Only these former app keys are migration targets. Current selected-position attempts use a separate key.
const prefixes = ["sofinance:atomic:", "usdc-position-zap:atomic:"];

export function readObsoleteAttempts(storage: Pick<Storage, "length" | "key" | "getItem">, wallet: string) {
  const attempts: ObsoleteAttempt[] = [];
  const keys: string[] = [];
  let invalid = false;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key || !prefixes.some((prefix) => key.startsWith(prefix)) || !key.endsWith(`:${wallet}`)) continue;
    keys.push(key);
    try {
      const raw = storage.getItem(key);
      const record: unknown = raw && JSON.parse(raw);
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
      const value = record as Record<string, unknown>;
      if (value.wallet !== wallet || typeof value.signature !== "string" ||
        bs58.decode(value.signature).length !== 64 || !Number.isSafeInteger(value.lastValidBlockHeight) ||
        (value.lastValidBlockHeight as number) <= 0) throw new Error();
      attempts.push({ key, signature: value.signature, lastValidBlockHeight: value.lastValidBlockHeight as number });
    } catch { invalid = true; }
  }
  return { attempts, keys, invalid };
}
