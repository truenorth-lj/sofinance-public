import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { readObsoleteAttempts } from "./obsolete-attempt";

describe("old local transaction migration", () => {
  it("only selects former keys for the connected wallet and reports malformed records", () => {
    const wallet = "wallet-A";
    const signature = bs58.encode(new Uint8Array(64).fill(1));
    const values = new Map([
      [`sofinance:atomic:old-position:${wallet}`, JSON.stringify({ wallet, signature, lastValidBlockHeight: 100 })],
      [`usdc-position-zap:atomic:old-position:${wallet}`, "invalid-json"],
      ["sofinance:selected-atomic:v2:wallet-A", "current-attempt"],
      ["sofinance:atomic:old-position:wallet-B", "other-wallet"],
    ]);
    const keys = [...values.keys()];
    const storage = { length: keys.length, key: (index: number) => keys[index] ?? null,
      getItem: (key: string) => values.get(key) ?? null };
    expect(readObsoleteAttempts(storage, wallet)).toEqual({
      attempts: [{ key: `sofinance:atomic:old-position:${wallet}`, signature, lastValidBlockHeight: 100 }],
      keys: [`sofinance:atomic:old-position:${wallet}`, `usdc-position-zap:atomic:old-position:${wallet}`],
      invalid: true,
    });
  });
});
