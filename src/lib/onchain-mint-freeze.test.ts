import { PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { mintDataHasFreezeAuthority, readMintFreezeAuthorities, readMintSafety } from "./onchain-mint-freeze";
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

describe("readMintSafety", () => {
  it("returns freeze authority and no block reasons for classic SPL mints, from the same single batch", async () => {
    const { conn, calls } = connection();
    const result = await readMintSafety(conn, [CBBTC, WBTC]);
    expect([...result]).toEqual([[CBBTC, { freezeAuthority: true, blockReasons: [] }], [WBTC, { freezeAuthority: false, blockReasons: [] }]]);
    expect(calls).toEqual([[CBBTC, WBTC]]);
  });

  it("reads Token-2022 block reasons (paused) and leaves out a missing account", async () => {
    const accounts = meteoraAccounts();
    // A Token-2022 mint: base layout (82 bytes) + padding to 165 + account type (1 = Mint) + PausableConfig TLV (paused).
    const data = Buffer.alloc(166 + 4 + 33);
    Buffer.from(accounts[WBTC]!.data, "base64").copy(data, 0, 0, 82);
    data.writeUInt8(1, 165);
    data.writeUInt16LE(26, 166); // ExtensionType.PausableConfig
    data.writeUInt16LE(33, 168);
    data.writeUInt8(1, 170 + 32); // paused = true
    const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const { conn } = connection(meteoraAccounts({ [WBTC]: { ...accounts[WBTC]!, owner: T22, data: data.toString("base64") } }));
    const result = await readMintSafety(conn, [WBTC, "So11111111111111111111111111111111111111112"]);
    expect([...result]).toEqual([[WBTC, { freezeAuthority: false, blockReasons: ["paused"] }]]);
    expect([...(await readMintFreezeAuthorities(conn, [WBTC]))]).toEqual([[WBTC, false]]);
  });
});

describe("readMintSafety batching", () => {
  it("reads at most 100 mints per getMultipleAccounts call (the RPC limit)", async () => {
    const sizes: number[] = [];
    const conn = { getMultipleAccountsInfo: async (keys: PublicKey[]) => { sizes.push(keys.length); return keys.map(() => null); } } as unknown as Connection;
    const mints = Array.from({ length: 230 }, () => PublicKey.unique().toBase58());
    await readMintSafety(conn, mints);
    expect(sizes).toEqual([100, 100, 30]);
  });
});
