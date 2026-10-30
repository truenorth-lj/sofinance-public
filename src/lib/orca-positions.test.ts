import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
  getOrcaPositionPerformance, listOrcaPositions, ORCA_POOL_NOT_SUPPORTED, readOrcaPosition, readOrcaPositionRangeFacts,
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
function tokenAccount(mint: string, owner: string, amount: bigint, program = TOKEN_2022_PROGRAM_ID) {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return { owner: program, data };
}
function hold(store: Store, mint: string, wallet: string, amount = 1n, program = TOKEN_2022_PROGRAM_ID) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet), true, program);
  store.set(ata.toBase58(), tokenAccount(mint, wallet, amount, program));
}

type Store = Map<string, { owner: PublicKey; data: Buffer }>;
type Options = import("./orca-positions").OrcaPerformanceOptions;
function fakeConnection(store: Store) {
  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) => store.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => store.get(key.toBase58()) ?? null)),
    // Token accounts of a program whose owner field is the wallet (what the RPC returns for a programId filter).
    getTokenAccountsByOwner: vi.fn(async (wallet: PublicKey, filter: { programId: PublicKey }) => ({
      context: { slot: 1 },
      value: [...store.entries()]
        .filter(([, account]) => account.owner.equals(filter.programId) && account.data.length === 165 && new PublicKey(account.data.subarray(32, 64)).equals(wallet))
        .map(([address, account]) => ({ pubkey: new PublicKey(address), account: { ...account, executable: false, lamports: 1, rentEpoch: 0 } })),
    })),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransaction: vi.fn(async () => null),
  };
  return connection as unknown as typeof connection & NonNullable<Options["connection"]>;
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

describe("Orca position reads (shown wherever they were opened)", () => {
  let store: Store;
  beforeEach(() => { store = baseStore(); vi.mocked(fetchPositionHistoryTransactions).mockReset(); });

  it("treats a mint without an Orca position account as not Orca (Raydium falls through)", async () => {
    const connection = fakeConnection(store);
    await expect(readOrcaPosition(new PublicKey(Buffer.alloc(32, 7)).toBase58(), { connection })).resolves.toBeNull();
  });

  it("reads any Orca position in an allowlisted pool without the open log or its signature history", async () => {
    const connection = fakeConnection(store);
    const read = await readOrcaPosition(mintOf(BELOW), { connection });
    expect(read!.snapshot).toMatchObject({ positionAccount: BELOW, poolId: accounts.pool, rangeSide: "below" });
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("rejects a position in a pool that is not allowlisted", async () => {
    const position = store.get(BELOW)!;
    const foreign = Buffer.from(position.data);
    new PublicKey(Buffer.alloc(32, 9)).toBuffer().copy(foreign, 8); // whirlpool field
    store.set(BELOW, { owner: position.owner, data: foreign });
    await expect(readOrcaPosition(mintOf(BELOW), { connection: fakeConnection(store) })).rejects.toThrow(ORCA_POOL_NOT_SUPPORTED);
  });

  it("reports range facts from the captured pool state", async () => {
    const connection = fakeConnection(store);
    const inRange = await readOrcaPositionRangeFacts(mintOf(IN_RANGE), { connection });
    expect(inRange).toMatchObject({ poolId: accounts.pool, mintA: CBBTC, mintB: WBTC, decimalsA: 8, decimalsB: 8, tickLower: 9, tickUpper: 29 });
    expect(inRange!.onChainPriceBPerA).toBeGreaterThan(1.0001 ** 9);
    expect(inRange!.onChainPriceBPerA).toBeLessThan(1.0001 ** 29);
    const above = await readOrcaPositionRangeFacts(mintOf(ABOVE), { connection });
    expect(above!.onChainPriceBPerA).toBeGreaterThanOrEqual(1.0001 ** above!.tickUpper);
  });

  it("lists the position NFTs the wallet holds (SPL Token and Token-2022) in allowlisted pools", async () => {
    const connection = fakeConnection(store);
    await expect(listOrcaPositions(OWNER, { connection })).resolves.toEqual([]); // no NFTs held
    expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();

    hold(store, mintOf(BELOW), OWNER); // Token-2022 position NFT
    hold(store, mintOf(IN_RANGE), OWNER, 1n, TOKEN_PROGRAM_ID); // legacy SPL position NFT
    hold(store, mintOf(ABOVE), OWNER, 0n); // emptied token account: not held
    hold(store, CBBTC, OWNER, 5n, TOKEN_PROGRAM_ID); // fungible balance: not an NFT
    hold(store, WBTC, OWNER, 1n, TOKEN_PROGRAM_ID); // 1 raw unit of a fungible token: no Orca position PDA
    vi.clearAllMocks();
    const listed = await listOrcaPositions(OWNER, { connection });
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocol: "orca-whirlpool", positionMint: mintOf(BELOW), positionAccount: BELOW,
        poolId: accounts.pool, mintA: CBBTC, mintB: WBTC, tickLower: 18, tickUpper: 38, rangeSide: "below" }),
      expect.objectContaining({ positionMint: mintOf(IN_RANGE), positionAccount: IN_RANGE, tickLower: 9, tickUpper: 29, rangeSide: "inside" }),
    ]));
    // 2 token-account scans, 1 batch of position PDAs, 1 batch of pools; no per-position or provenance reads.
    expect(connection.getTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();

    // Someone else's wallet does not see these positions.
    await expect(listOrcaPositions(new PublicKey(Buffer.alloc(32, 3)).toBase58(), { connection })).resolves.toEqual([]);
  });

  it("skips held positions in pools that are not allowlisted", async () => {
    const position = store.get(BELOW)!;
    const foreign = Buffer.from(position.data);
    new PublicKey(Buffer.alloc(32, 9)).toBuffer().copy(foreign, 8);
    store.set(BELOW, { owner: position.owner, data: foreign });
    hold(store, mintOf(BELOW), OWNER);
    await expect(listOrcaPositions(OWNER, { connection: fakeConnection(store) })).resolves.toEqual([]);
  });

  it("computes performance from the parsed receipts and live state", async () => {
    const items = historyOf(BELOW).map((tx) => ({ signature: tx.label, slot: tx.slot as unknown as number, blockTime: tx.blockTime as unknown as number,
      err: null, logMessages: tx.meta!.logMessages ?? null, parsedTransaction: tx }));
    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue({ items, truncated: false, signatureCount: items.length, metric: {} as never });
    const result = await getOrcaPositionPerformance(mintOf(BELOW), {
      connection: fakeConnection(store), skipPricing: true,
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

    // History that does not reach the open is reported as incomplete.
    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue({ items: items.slice(1), truncated: true, signatureCount: 500, metric: {} as never });
    const partial = await getOrcaPositionPerformance(mintOf(BELOW), {
      connection: fakeConnection(store), skipPricing: true,
    });
    expect(partial!.assumptions).toMatch(/incomplete/);
    expect(partial!.metrics.feeOnlyAprPct).toBeNull();
  });
});
