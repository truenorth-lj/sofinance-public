import { PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { mintDataHasFreezeAuthority, readMintFreezeAuthorities } from "./onchain-mint-freeze";
import { meteoraAccounts } from "./range-apr/meteora-chain.fixture";

const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";

function connection(accounts = meteoraAccounts()) {
  const calls: string[][] = [];
  const conn = { getMultipleAccountsInfo: async (keys: PublicKey[]) => {
    calls.push(keys.map((key) => key.toBase58()));
    return keys.map((key) => {
      const raw = accounts[key.toBase58()];
      return raw ? { owner: new PublicKey(raw.owner), data: Buffer.from(raw.data, "base64"), lamports: 1, executable: false } : null;
    });
  } } as unknown as Connection;
  return { conn, calls };
}

describe("readMintFreezeAuthorities", () => {
  it("reads cbBTC (set) and WBTC (none) in one deduplicated batch", async () => {
    const { conn, calls } = connection();
    const result = await readMintFreezeAuthorities(conn, [CBBTC, WBTC, CBBTC]);
    expect([...result]).toEqual([[CBBTC, true], [WBTC, false]]);
    expect(calls).toEqual([[CBBTC, WBTC]]);
    expect((await readMintFreezeAuthorities(conn, [])).size).toBe(0);
  });

  it("leaves out missing, foreign-owned or malformed mints", async () => {
    const accounts = meteoraAccounts();
    const bad = Buffer.from(accounts[WBTC]!.data, "base64"); bad.writeUInt32LE(7, 46);
    const { conn } = connection(meteoraAccounts({
      [CBBTC]: { ...accounts[CBBTC]!, owner: "11111111111111111111111111111111" },
      [WBTC]: { ...accounts[WBTC]!, data: bad.toString("base64") },
    }));
    expect((await readMintFreezeAuthorities(conn, [CBBTC, WBTC, "So11111111111111111111111111111111111111112"])).size).toBe(0);
    expect(() => mintDataHasFreezeAuthority(new Uint8Array(10))).toThrow();
  });
});
