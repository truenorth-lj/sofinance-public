import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));

const {
  listMeteoraPositions, METEORA_POOL_NOT_SUPPORTED, readMeteoraPosition, readMeteoraPositionRangeFacts, readMeteoraPositionSnapshot,
} = await import("./meteora-positions");
const { rangeStatusFromPrice } = await import("./position-range-status");

const POOL = fixture.pool;
const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const [IN_RANGE, SPANNING, ABOVE, BELOW, EMPTY] = fixture.positions as [string, string, string, string, string];
const expected = fixture.expected as Record<string, { owner: string; totalXAmount: string; totalYAmount: string; feeX: string; feeY: string }>;
const OWNER = expected[IN_RANGE]!.owner;

type Account = { owner: PublicKey; data: Buffer };
type Store = Map<string, Account>;
function storeFrom(overrides: Record<string, Account | null> = {}): Store {
  const store: Store = new Map();
  for (const [address, raw] of Object.entries(fixture.accounts)) {
    if (raw) store.set(address, { owner: new PublicKey(raw.owner), data: Buffer.from(raw.data, "base64") });
  }
  for (const [address, account] of Object.entries(overrides)) {
    if (account) store.set(address, account); else store.delete(address);
  }
  return store;
}

type Filter = { memcmp: { offset: number; bytes: string } };
type GpaConfig = { filters: Filter[]; dataSlice?: { offset: number; length: number } };
type ReadConnection = NonNullable<import("./meteora-positions").MeteoraReadOptions["connection"]>;
function fakeConnection(store: Store) {
  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) => store.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => store.get(key.toBase58()) ?? null)),
    getProgramAccounts: vi.fn(async (program: PublicKey, config?: unknown) => [...store.entries()]
      .filter(([, account]) => account.owner.equals(program))
      .filter(([, account]) => (config as GpaConfig).filters.every(({ memcmp }) => {
        const want = Buffer.from(bs58.decode(memcmp.bytes));
        return account.data.subarray(memcmp.offset, memcmp.offset + want.length).equals(want);
      }))
      .map(([address, account]) => {
        const slice = (config as GpaConfig).dataSlice;
        const data = slice ? account.data.subarray(slice.offset, slice.offset + slice.length) : account.data;
        return { pubkey: new PublicKey(address), account: { ...account, data } };
      })),
    getSignaturesForAddress: vi.fn(async () => []),
  };
  return connection as typeof connection & ReadConnection;
}

describe("Meteora DLMM position snapshot", () => {
  it("values positions from one batched read, matching the SDK capture", async () => {
    const connection = fakeConnection(storeFrom());
    for (const address of fixture.positions) {
      const snapshot = (await readMeteoraPositionSnapshot(address, connection))!;
      const want = expected[address]!;
      expect({ x: snapshot.amounts.x.toString(), y: snapshot.amounts.y.toString(), fx: snapshot.uncollected.x.toString(), fy: snapshot.uncollected.y.toString() })
        .toEqual({ x: want.totalXAmount, y: want.totalYAmount, fx: want.feeX, fy: want.feeY });
      expect(snapshot).toMatchObject({ poolId: POOL, decimalsX: 8, decimalsY: 8 });
    }
    expect((await readMeteoraPositionSnapshot(ABOVE, connection))!.rangeSide).toBe("above");
    expect((await readMeteoraPositionSnapshot(BELOW, connection))!.rangeSide).toBe("below");
    expect((await readMeteoraPositionSnapshot(SPANNING, connection))!.rangeSide).toBe("inside");
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(fixture.positions.length + 3); // one batch per snapshot
  });

  it("returns null for non-position accounts and fails on foreign pools or missing state", async () => {
    const connection = fakeConnection(storeFrom());
    expect(await readMeteoraPositionSnapshot(POOL, connection)).toBeNull();
    expect(await readMeteoraPositionSnapshot(CBBTC, connection)).toBeNull();
    expect(await readMeteoraPositionSnapshot("11111111111111111111111111111111", connection)).toBeNull();

    const foreign = Buffer.from(storeFrom().get(IN_RANGE)!.data);
    new PublicKey(CBBTC).toBuffer().copy(foreign, 8);
    const program = storeFrom().get(IN_RANGE)!.owner;
    await expect(readMeteoraPositionSnapshot(IN_RANGE, fakeConnection(storeFrom({ [IN_RANGE]: { owner: program, data: foreign } }))))
      .rejects.toThrow(METEORA_POOL_NOT_SUPPORTED);
    const arrays = Object.keys(fixture.accounts).slice(3, 6);
    await expect(readMeteoraPositionSnapshot(IN_RANGE, fakeConnection(storeFrom({ [arrays[0]!]: null }))))
      .rejects.toThrow("bin array missing");
    await expect(readMeteoraPositionSnapshot(IN_RANGE, fakeConnection(storeFrom({ [POOL]: null }))))
      .rejects.toThrow("LbPair account missing");
  });
});

describe("Meteora positions are shown wherever they were opened", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads any position in an allowlisted pool without the open log or its signature history", async () => {
    const connection = fakeConnection(storeFrom());
    const read = await readMeteoraPosition(IN_RANGE, { connection });
    expect(read!.snapshot).toMatchObject({ positionAccount: IN_RANGE, poolId: POOL, rangeSide: "inside" });
    expect(await readMeteoraPosition(POOL, { connection })).toBeNull();
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});

describe("listMeteoraPositions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds every position the wallet owns in allowlisted pools with one owner-filtered program scan", async () => {
    const connection = fakeConnection(storeFrom());
    const listed = await listMeteoraPositions(OWNER, { connection });
    const owned = fixture.positions.filter((address) => expected[address]!.owner === OWNER).sort();
    expect(listed.map((row) => row.positionAccount)).toEqual(owned);
    expect(listed.find((row) => row.positionAccount === IN_RANGE)).toEqual({
      protocol: "meteora-dlmm", positionMint: IN_RANGE, positionAccount: IN_RANGE, poolId: POOL,
      mintA: CBBTC, mintB: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      tickLower: -15, tickUpper: 54, tickCurrent: 16, lowerBinId: -15, upperBinId: 53, activeBinId: 16, rangeSide: "inside",
      liquidity: expect.stringMatching(/^\d+$/),
      amountsRaw: { a: expected[IN_RANGE]!.totalXAmount, b: expected[IN_RANGE]!.totalYAmount },
      uncollectedFeesRaw: { a: expected[IN_RANGE]!.feeX, b: expected[IN_RANGE]!.feeY },
    });
    // One program scan (discriminator + owner, head bytes only), no per-pool loop, no signature history.
    expect(connection.getProgramAccounts).toHaveBeenCalledTimes(1);
    const [, config] = connection.getProgramAccounts.mock.calls[0]!;
    expect((config as GpaConfig).filters.map((filter) => filter.memcmp.offset)).toEqual([0, 40]);
    expect((config as GpaConfig).dataSlice).toEqual({ offset: 0, length: 72 });
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
    // Other owners' positions are never returned by the owner filter.
    const other = expected[EMPTY]!.owner;
    const otherOwned = fixture.positions.filter((address) => expected[address]!.owner === other).sort();
    expect((await listMeteoraPositions(other, { connection })).map((row) => row.positionAccount)).toEqual(otherOwned);
    expect(await listMeteoraPositions("11111111111111111111111111111112", { connection })).toEqual([]);
  });

  it("skips positions in pools that are not allowlisted", async () => {
    const foreign = Buffer.from(storeFrom().get(IN_RANGE)!.data);
    new PublicKey(CBBTC).toBuffer().copy(foreign, 8);
    const program = storeFrom().get(IN_RANGE)!.owner;
    const connection = fakeConnection(storeFrom({ [IN_RANGE]: { owner: program, data: foreign } }));
    const listed = await listMeteoraPositions(OWNER, { connection });
    expect(listed.map((row) => row.positionAccount)).not.toContain(IN_RANGE);
  });
});

describe("readMeteoraPositionRangeFacts", () => {
  it("maps bins [lower, upper] to ticks [lower, upper + 1) with the active bin midpoint as price", async () => {
    const connection = fakeConnection(storeFrom());
    const facts = (await readMeteoraPositionRangeFacts(IN_RANGE, { connection }))!;
    expect(facts).toMatchObject({ protocol: "meteora-dlmm", positionMint: IN_RANGE, tickLower: -15, tickUpper: 54, tickCurrent: 16, activeBinId: 16 });
    expect(facts.activeBinPriceBPerA).toBeCloseTo(1.0001 ** 16, 12);
    expect(rangeStatusFromPrice({ ...facts, priceBPerA: facts.onChainPriceBPerA })).toMatchObject({ rangeSide: "inside", inRange: true });
    const below = (await readMeteoraPositionRangeFacts(BELOW, { connection }))!;
    expect(rangeStatusFromPrice({ ...below, priceBPerA: below.onChainPriceBPerA }).rangeSide).toBe("below");
    expect(await readMeteoraPositionRangeFacts(POOL, { connection })).toBeNull();
  });

  it("reads an edge bin as in range (active bin = lower or upper bin)", () => {
    for (const bins of [[16, 20], [10, 16], [16, 16]] as const) {
      const status = rangeStatusFromPrice({ tickLower: bins[0], tickUpper: bins[1] + 1, decimalsA: 8, decimalsB: 8, priceBPerA: 1.0001 ** 16.5 });
      expect(status.inRange, String(bins)).toBe(true);
    }
  });
});
