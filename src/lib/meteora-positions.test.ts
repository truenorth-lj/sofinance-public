import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));

const {
  listMeteoraPositions, METEORA_NOT_SHOWN, METEORA_OPENS_DB_MISSING, readMeteoraPositionRangeFacts, readMeteoraPositionSnapshot, readShownMeteoraPosition,
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
type ReadConnection = NonNullable<import("./meteora-positions").MeteoraReadOptions["connection"]>;
function fakeConnection(store: Store, signatures: Record<string, Array<{ signature: string; err: unknown }>> = {}) {
  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) => store.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => store.get(key.toBase58()) ?? null)),
    getProgramAccounts: vi.fn(async (program: PublicKey, config?: unknown) => [...store.entries()]
      .filter(([, account]) => account.owner.equals(program))
      .filter(([, account]) => ((config as { filters: Filter[] }).filters).every(({ memcmp }) => {
        const want = Buffer.from(bs58.decode(memcmp.bytes));
        return account.data.subarray(memcmp.offset, memcmp.offset + want.length).equals(want);
      }))
      .map(([address, account]) => ({ pubkey: new PublicKey(address), account }))),
    getSignaturesForAddress: vi.fn(async (key: PublicKey, options?: { limit?: number; before?: string }) => {
      const all = signatures[key.toBase58()] ?? [];
      const start = options?.before ? all.findIndex((item) => item.signature === options.before) + 1 : 0;
      return all.slice(start, start + (options?.limit ?? 1000));
    }),
  };
  return connection as typeof connection & ReadConnection;
}

/** Opens log with one row per (signature, pool, wallet). */
function fakeSql(rows: Array<{ tx_signature: string; pool_address: string; wallet: string }>) {
  return {
    unsafe: vi.fn(async (query: string, params?: unknown[]) => {
      if (/CREATE|INSERT|UPDATE|DELETE/i.test(query)) throw new Error("no DDL/DML expected");
      const [signature, pool] = params as [string, string];
      return rows.filter((row) => row.tx_signature === signature && row.pool_address === pool).map(({ wallet }) => ({ wallet }));
    }),
  };
}

// Newest first, like getSignaturesForAddress: the open is the oldest successful one.
const history = { [IN_RANGE]: [{ signature: "sig-claim", err: null }, { signature: "sig-open", err: null }, { signature: "sig-failed", err: {} }] };

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
      .rejects.toThrow(METEORA_NOT_SHOWN);
    const arrays = Object.keys(fixture.accounts).slice(3, 6);
    await expect(readMeteoraPositionSnapshot(IN_RANGE, fakeConnection(storeFrom({ [arrays[0]!]: null }))))
      .rejects.toThrow("bin array missing");
    await expect(readMeteoraPositionSnapshot(IN_RANGE, fakeConnection(storeFrom({ [POOL]: null }))))
      .rejects.toThrow("LbPair account missing");
  });
});

describe("Meteora provenance (SoFinance-opened only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a position whose first successful signature is a logged open by its owner", async () => {
    const connection = fakeConnection(storeFrom(), history);
    const sql = fakeSql([{ tx_signature: "sig-open", pool_address: POOL, wallet: OWNER }]);
    const shown = await readShownMeteoraPosition(IN_RANGE, { connection, sql });
    expect(shown!.provenance).toEqual({ openSignature: "sig-open", wallet: OWNER });
  });

  it("hides positions not opened through SoFinance, logged by another wallet, or without the open log", async () => {
    const connection = fakeConnection(storeFrom(), history);
    await expect(readShownMeteoraPosition(IN_RANGE, { connection, sql: fakeSql([]) })).rejects.toThrow(METEORA_NOT_SHOWN);
    await expect(readShownMeteoraPosition(IN_RANGE, { connection, sql: fakeSql([{ tx_signature: "sig-claim", pool_address: POOL, wallet: OWNER }]) }))
      .rejects.toThrow(METEORA_NOT_SHOWN);
    await expect(readShownMeteoraPosition(IN_RANGE, { connection, sql: fakeSql([{ tx_signature: "sig-open", pool_address: POOL, wallet: CBBTC }]) }))
      .rejects.toThrow(METEORA_NOT_SHOWN);
    await expect(readShownMeteoraPosition(IN_RANGE, { connection, sql: null })).rejects.toThrow(METEORA_OPENS_DB_MISSING);
    expect(await readShownMeteoraPosition(POOL, { connection, sql: null })).toBeNull();
  });

  it("fails closed when the history is longer than the provenance bound", async () => {
    const long = Array.from({ length: 5000 }, (_, i) => ({ signature: `s${i}`, err: null }));
    const connection = fakeConnection(storeFrom(), { [IN_RANGE]: long });
    const sql = fakeSql([{ tx_signature: "s4999", pool_address: POOL, wallet: OWNER }]);
    await expect(readShownMeteoraPosition(IN_RANGE, { connection, sql })).rejects.toThrow(METEORA_NOT_SHOWN);
  });
});

describe("listMeteoraPositions", () => {
  it("finds the wallet's positions by owner + pool and lists only SoFinance-opened ones", async () => {
    const connection = fakeConnection(storeFrom(), history);
    const sql = fakeSql([{ tx_signature: "sig-open", pool_address: POOL, wallet: OWNER }]);
    const listed = await listMeteoraPositions(OWNER, { connection, sql });
    expect(listed).toEqual([{
      protocol: "meteora-dlmm", positionMint: IN_RANGE, positionAccount: IN_RANGE, poolId: POOL,
      mintA: CBBTC, mintB: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      tickLower: -15, tickUpper: 54, tickCurrent: 16, lowerBinId: -15, upperBinId: 53, activeBinId: 16, rangeSide: "inside",
      liquidity: expect.stringMatching(/^\d+$/),
      amountsRaw: { a: expected[IN_RANGE]!.totalXAmount, b: expected[IN_RANGE]!.totalYAmount },
      uncollectedFeesRaw: { a: expected[IN_RANGE]!.feeX, b: expected[IN_RANGE]!.feeY },
    }]);
    const [, config] = connection.getProgramAccounts.mock.calls[0]!;
    expect((config as { filters: Filter[] }).filters.map((filter) => filter.memcmp.offset)).toEqual([0, 8, 40]);
    // Other owners' positions are never returned by the owner filter.
    expect(await listMeteoraPositions(expected[EMPTY]!.owner, { connection, sql })).toEqual([]);
    await expect(listMeteoraPositions(OWNER, { connection, sql: null })).rejects.toThrow(METEORA_OPENS_DB_MISSING);
  });
});

describe("readMeteoraPositionRangeFacts", () => {
  it("maps bins [lower, upper] to ticks [lower, upper + 1) with the active bin midpoint as price", async () => {
    const connection = fakeConnection(storeFrom(), { ...history, [BELOW]: [{ signature: "sig-open-below", err: null }] });
    const sql = fakeSql([
      { tx_signature: "sig-open", pool_address: POOL, wallet: OWNER },
      { tx_signature: "sig-open-below", pool_address: POOL, wallet: expected[BELOW]!.owner },
    ]);
    const facts = (await readMeteoraPositionRangeFacts(IN_RANGE, { connection, sql }))!;
    expect(facts).toMatchObject({ protocol: "meteora-dlmm", positionMint: IN_RANGE, tickLower: -15, tickUpper: 54, tickCurrent: 16, activeBinId: 16 });
    expect(facts.activeBinPriceBPerA).toBeCloseTo(1.0001 ** 16, 12);
    expect(rangeStatusFromPrice({ ...facts, priceBPerA: facts.onChainPriceBPerA })).toMatchObject({ rangeSide: "inside", inRange: true });
    const below = (await readMeteoraPositionRangeFacts(BELOW, { connection, sql }))!;
    expect(rangeStatusFromPrice({ ...below, priceBPerA: below.onChainPriceBPerA }).rangeSide).toBe("below");
    expect(await readMeteoraPositionRangeFacts(POOL, { connection, sql })).toBeNull();
  });

  it("reads an edge bin as in range (active bin = lower or upper bin)", () => {
    for (const bins of [[16, 20], [10, 16], [16, 16]] as const) {
      const status = rangeStatusFromPrice({ tickLower: bins[0], tickUpper: bins[1] + 1, decimalsA: 8, decimalsB: 8, priceBPerA: 1.0001 ** 16.5 });
      expect(status.inRange, String(bins)).toBe(true);
    }
  });
});
