import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import accounts from "../../packages/engine/src/fixtures/orca-positions-cbbtc-wbtc.json";
import fixtures from "./fixtures/orca-position-history-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));
vi.mock("./position-performance-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./position-performance-history")>()),
  fetchPositionHistoryTransactions: vi.fn(),
}));

const { fetchPositionHistoryTransactions } = await import("./position-performance-history");
const {
  getOrcaPositionPerformance, listOrcaPositions, ORCA_NOT_SHOWN, readOrcaPositionRangeFacts, readShownOrcaPosition,
} = await import("./orca-positions");

const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const [IN_RANGE, ABOVE, BELOW] = accounts.positions as [string, string, string];
const mintOf = (position: string) => accounts.positionMints[accounts.positions.indexOf(position)]!;
const hydrate = (value: unknown) => JSON.parse(JSON.stringify(value), (key, v) => {
  if (key === "programId") return new PublicKey(v);
  if (key === "accounts" && Array.isArray(v)) return v.map((address: string) => new PublicKey(address));
  return v;
}) as ParsedTransactionWithMeta & { label: string; position: string };
const history = fixtures.map(hydrate);
const historyOf = (position: string) => history.filter((tx) => tx.position === position);
const openTx = historyOf(BELOW)[0]!;
const OWNER = openTx.transaction.message.instructions[3]!.programId.toBase58() === WHIRLPOOL
  ? (openTx.transaction.message.instructions[3] as { accounts: PublicKey[] }).accounts[1]!.toBase58() : "";

function mintAccount(decimals: number) {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data };
}
function tokenAccount(mint: string, owner: string, amount: bigint) {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return { owner: TOKEN_2022_PROGRAM_ID, data };
}

type Store = Map<string, { owner: PublicKey; data: Buffer }>;
type Options = import("./orca-positions").OrcaReadOptions;
function fakeConnection(store: Store, signatures: Record<string, Array<{ signature: string; err: unknown }>> = {}) {
  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) => store.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => store.get(key.toBase58()) ?? null)),
    getSignaturesForAddress: vi.fn(async (key: PublicKey, options?: { limit?: number; before?: string }) => {
      const all = signatures[key.toBase58()] ?? [];
      const start = options?.before ? all.findIndex((item) => item.signature === options.before) + 1 : 0;
      return all.slice(start, start + (options?.limit ?? 1000));
    }),
    getParsedTransaction: vi.fn(async (signature: string) => (signature === "sig-open-below" ? openTx : null)),
  };
  return connection as typeof connection & NonNullable<Options["connection"]>;
}
function baseStore(): Store {
  const store: Store = new Map();
  for (const [address, account] of Object.entries(accounts.accounts as Record<string, { owner: string; data: string }>)) {
    store.set(address, { owner: new PublicKey(account.owner), data: Buffer.from(account.data, "base64") });
  }
  store.set(CBBTC, mintAccount(8));
  store.set(WBTC, mintAccount(8));
  return store;
}
const opensRows = (rows: Array<Record<string, string>>) => {
  const sql = { unsafe: vi.fn<(text: string, params: unknown[]) => Promise<typeof rows>>(async () => rows) };
  return sql as typeof sql & NonNullable<Options["sql"]>;
};
const signaturesFor = (position: string, oldest: string) => ({ [position]: [{ signature: "later", err: null }, { signature: oldest, err: null }, { signature: "failed-attempt", err: { x: 1 } }] });

describe("Orca position reads (shown only when opened through SoFinance)", () => {
  let store: Store;
  beforeEach(() => { store = baseStore(); vi.mocked(fetchPositionHistoryTransactions).mockReset(); });

  it("treats a mint without an Orca position account as not Orca (Raydium falls through)", async () => {
    const connection = fakeConnection(store);
    await expect(readShownOrcaPosition(new PublicKey(Buffer.alloc(32, 7)).toBase58(), { connection, sql: opensRows([]) })).resolves.toBeNull();
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("hides positions without a SoFinance open: no opens database, no row, or a row for another transaction", async () => {
    for (const sql of [null, opensRows([])]) {
      await expect(readShownOrcaPosition(mintOf(BELOW), { connection: fakeConnection(store, signaturesFor(BELOW, "sig-open-below")), sql }))
        .rejects.toThrow(ORCA_NOT_SHOWN);
    }
    const sql = opensRows([{ wallet: OWNER }]);
    await readShownOrcaPosition(mintOf(BELOW), { connection: fakeConnection(store, signaturesFor(BELOW, "sig-open-below")), sql });
    // The oldest successful signature is checked; failed attempts are skipped.
    expect(sql.unsafe.mock.calls[0]![1]).toEqual(["sig-open-below", accounts.pool]);
    expect(sql.unsafe.mock.calls[0]![0]).toMatch(/^SELECT wallet FROM sofinance_position_opens WHERE tx_signature = \$1 AND pool_address = \$2/);
  });

  it("fails closed when the position history is too long to reach its open, or the log cannot be read", async () => {
    const long = { [BELOW]: Array.from({ length: 5000 }, (_, index) => ({ signature: `s${index}`, err: null })) };
    await expect(readShownOrcaPosition(mintOf(BELOW), { connection: fakeConnection(store, long), sql: opensRows([{ wallet: OWNER }]) }))
      .rejects.toThrow(ORCA_NOT_SHOWN);
    const broken = { unsafe: vi.fn(async () => { throw new Error('relation "sofinance_position_opens" does not exist'); }) } as unknown as NonNullable<Options["sql"]>;
    await expect(readShownOrcaPosition(mintOf(BELOW), { connection: fakeConnection(store, signaturesFor(BELOW, "sig-open-below")), sql: broken }))
      .rejects.toThrow(ORCA_NOT_SHOWN);
  });

  it("reports range facts for a shown position from the captured pool state", async () => {
    const options = (position: string) => ({ connection: fakeConnection(store, signaturesFor(position, "sig")), sql: opensRows([{ wallet: OWNER }]) });
    const inRange = await readOrcaPositionRangeFacts(mintOf(IN_RANGE), options(IN_RANGE));
    expect(inRange).toMatchObject({ poolId: accounts.pool, mintA: CBBTC, mintB: WBTC, decimalsA: 8, decimalsB: 8, tickLower: 9, tickUpper: 29 });
    expect(inRange!.onChainPriceBPerA).toBeGreaterThan(1.0001 ** 9);
    expect(inRange!.onChainPriceBPerA).toBeLessThan(1.0001 ** 29);
    const above = await readOrcaPositionRangeFacts(mintOf(ABOVE), options(ABOVE));
    expect(above!.onChainPriceBPerA).toBeGreaterThanOrEqual(1.0001 ** above!.tickUpper);
  });

  it("lists only logged opens in allowlisted pools that the wallet still holds", async () => {
    const sql = opensRows([{ tx_signature: "sig-open-below" }, { tx_signature: "sig-unknown" }]);
    const connection = fakeConnection(store, signaturesFor(BELOW, "sig-open-below"));
    await expect(listOrcaPositions(OWNER, { connection, sql })).resolves.toEqual([]); // NFT not held

    const ata = getAssociatedTokenAddressSync(new PublicKey(mintOf(BELOW)), new PublicKey(OWNER), true, TOKEN_2022_PROGRAM_ID);
    store.set(ata.toBase58(), tokenAccount(mintOf(BELOW), OWNER, 1n));
    const listed = await listOrcaPositions(OWNER, { connection, sql });
    expect(listed).toEqual([expect.objectContaining({ protocol: "orca-whirlpool", positionMint: mintOf(BELOW), positionAccount: BELOW,
      poolId: accounts.pool, mintA: CBBTC, mintB: WBTC, tickLower: 18, tickUpper: 38, rangeSide: "below" })]);
    expect(sql.unsafe.mock.calls[0]![1]).toEqual([OWNER, [accounts.pool]]);

    // A logged signature that is not the position's first transaction is not its open.
    const notOpen = fakeConnection(store, signaturesFor(BELOW, "sig-something-else"));
    await expect(listOrcaPositions(OWNER, { connection: notOpen, sql })).resolves.toEqual([]);
    await expect(listOrcaPositions(OWNER, { connection, sql: null })).resolves.toEqual([]);
  });

  it("computes performance from the parsed receipts and live state", async () => {
    const items = historyOf(BELOW).map((tx) => ({ signature: tx.label, slot: tx.slot as unknown as number, blockTime: tx.blockTime as unknown as number,
      err: null, logMessages: tx.meta!.logMessages ?? null, parsedTransaction: tx }));
    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue({ items, truncated: false, signatureCount: items.length, metric: {} as never });
    const result = await getOrcaPositionPerformance(mintOf(BELOW), {
      connection: fakeConnection(store, signaturesFor(BELOW, items[0]!.signature)), sql: opensRows([{ wallet: OWNER }]), skipPricing: true,
      nowSeconds: 1_800_000_000,
    });
    expect(result).toMatchObject({
      positionAccount: BELOW, poolId: accounts.pool, rangeSide: "below", truncated: false,
      cashflows: { depositedA: "982386", depositedB: "101184", withdrawnPrincipalA: "508877", withdrawnPrincipalB: "0",
        feesCollectedA: "2192", feesCollectedB: "2186", openCount: 1, increaseCount: 20, decreaseCount: 13 },
      pricing: { source: "none" },
    });
    expect(result!.openedAt).toBe(items[0]!.blockTime);
    expect(result!.metrics.holdingDays).toBeGreaterThan(0);
    expect(result!.assumptions).not.toMatch(/incomplete/);

    // History that does not reach the logged open is reported as incomplete.
    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue({ items: items.slice(1), truncated: true, signatureCount: 500, metric: {} as never });
    const partial = await getOrcaPositionPerformance(mintOf(BELOW), {
      connection: fakeConnection(store, signaturesFor(BELOW, items[0]!.signature)), sql: opensRows([{ wallet: OWNER }]), skipPricing: true,
    });
    expect(partial!.assumptions).toMatch(/incomplete/);
    expect(partial!.metrics.feeOnlyAprPct).toBeNull();
  });
});
