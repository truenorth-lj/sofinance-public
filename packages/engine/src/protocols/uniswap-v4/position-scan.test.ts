import { createPublicClient, custom, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { robinhoodChain } from "../../chains/robinhood";
import { STABLE_PAIR_HOOK, UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import {
  blockWindows, MAX_LOG_BLOCK_RANGE, POSITION_MANAGER_FIRST_BLOCK, readHeldPositions, receivedTokenIds, RESCAN_OVERLAP_BLOCKS, scanHoldings,
} from "./position-scan";
import { FAKE_ZERO_ADDRESS as ZERO, fakePosmRpc, type FakePosmRpc } from "./testing/fake-posm-rpc";

const USER = "0xB95b77e9429643cbaFdE865Fa2a9F687e8d21b04" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const HEAD = 101_764_305n;
const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;

const clientOf = (fake: FakePosmRpc) => createPublicClient({ chain: robinhoodChain, transport: custom({ request: fake.request }, { retryCount: 0 }) }) as PublicClient;
const logCalls = (fake: FakePosmRpc) => fake.calls.filter(c => c.method === "eth_getLogs").map(c => (c.params as [{ fromBlock: string; toBlock: string; topics: unknown[] }])[0]);

/** The LJ wallet: #4072237 held (opened at 100840683), three others opened and closed (burned). */
function ljWallet() {
  return fakePosmRpc({
    head: HEAD,
    nfts: [{ id: 4072237n, owner: USER, liquidity: 23_244_502_727_111_678_263n, hooks: STABLE_PAIR_HOOK.proxy }, { id: 4072036n, owner: null }, { id: 4077059n, owner: null }],
    transfers: [
      { id: 4072036n, from: ZERO, to: USER, block: 100_832_325n }, { id: 4072036n, from: USER, to: ZERO, block: 100_840_433n },
      { id: 4072237n, from: ZERO, to: USER, block: 100_840_683n },
      { id: 4077059n, from: ZERO, to: USER, block: 100_994_389n }, { id: 4077059n, from: USER, to: ZERO, block: 101_008_877n },
    ],
  });
}

describe("blockWindows", () => {
  it("covers the range in windows of at most 10M blocks", () => {
    const w = blockWindows(POSITION_MANAGER_FIRST_BLOCK, HEAD);
    expect(w).toHaveLength(11);
    expect(w[0]).toEqual([9_506n, 10_009_505n]);
    expect(w.at(-1)).toEqual([100_009_506n, HEAD]);
    for (const [s, e] of w) expect(e - s + 1n <= MAX_LOG_BLOCK_RANGE).toBe(true);
    expect(blockWindows(5n, 5n)).toEqual([[5n, 5n]]);
  });
});

describe("receivedTokenIds", () => {
  it("keeps only PositionManager ERC-721 transfers to the wallet", () => {
    const t = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const w = `0x${"0".repeat(24)}${USER.slice(2).toLowerCase()}`;
    const logs = [
      { address: "0x58daec3116aae6d93017baaea7749052e8a04fa7", blockNumber: "0x1", logIndex: "0x0", topics: [t, `0x${"0".repeat(64)}`, w, "0x05"] },
      { address: "0x58daec3116aae6d93017baaea7749052e8a04fa7", blockNumber: "0x1", logIndex: "0x1", topics: [t, `0x${"0".repeat(64)}`, w] }, // ERC-20 shape
      { address: "0x1111111111111111111111111111111111111111", blockNumber: "0x1", logIndex: "0x2", topics: [t, `0x${"0".repeat(64)}`, w, "0x06"] },
      { address: "0x58daec3116aae6d93017baaea7749052e8a04fa7", blockNumber: "0x1", logIndex: "0x3", topics: [t, `0x${"0".repeat(64)}`, w, "0x07"], removed: true },
    ];
    expect(receivedTokenIds(logs, USER)).toEqual(["5"]);
  });
});

describe("scanHoldings + readHeldPositions", () => {
  it("finds the NFT the wallet holds (#4072237) with no local record: 11 windowed to=wallet log queries + 1 multicall", async () => {
    const fake = ljWallet();
    const client = clientOf(fake);
    const state = await scanHoldings(client, USER, null, HEAD);
    expect(state).toEqual({ scannedTo: HEAD.toString(), candidates: ["4077059", "4072237", "4072036"] });
    const queries = logCalls(fake);
    expect(queries).toHaveLength(11);
    expect(queries[0]!.fromBlock).toBe("0x2522");
    expect(queries.every(q => q.topics[1] === null && String(q.topics[2]).endsWith(USER.slice(2).toLowerCase()))).toBe(true);

    const held = await readHeldPositions(client, USER, state.candidates);
    expect(fake.calls.filter(c => c.method === "eth_call")).toHaveLength(1);
    expect(held).toEqual([{
      tokenId: "4072237", hooks: STABLE_PAIR_HOOK.proxy, stablePair: true,
      position: { tokenId: "4072237", owner: USER, ownedByUser: true, liquidity: "23244502727111678263", tickLower: -21, tickUpper: 19, poolId: pool.poolId, baseSymbol: "SPCX" },
    }]);
  });

  it("drops an NFT the wallet sent to someone else (ownerOf confirms)", async () => {
    const fake = fakePosmRpc({ head: HEAD, nfts: [{ id: 9n, owner: OTHER }], transfers: [{ id: 9n, from: ZERO, to: USER, block: 100n }] });
    const client = clientOf(fake);
    const state = await scanHoldings(client, USER, null, HEAD);
    expect(await readHeldPositions(client, USER, state.candidates)).toEqual([]);
  });

  it("labels a held position outside the allowlist (poolId null; StablePair or another hook)", async () => {
    const fake = fakePosmRpc({ head: HEAD, nfts: [
      { id: 1n, owner: USER, hooks: STABLE_PAIR_HOOK.proxy, currency0: "0x3333333333333333333333333333333333333333" },
      { id: 2n, owner: USER, hooks: "0x0000000000000000000000000000000000000000" },
    ] });
    const held = await readHeldPositions(clientOf(fake), USER, ["1", "2"]);
    expect(held.map(h => [h.tokenId, h.position?.poolId, h.stablePair])).toEqual([["1", null, true], ["2", null, false]]);
  });

  it("incremental: only scans from scannedTo − overlap to the new head", async () => {
    const fake = ljWallet();
    const client = clientOf(fake);
    const first = await scanHoldings(client, USER, null, HEAD);
    fake.calls.length = 0;
    fake.transfers.push({ id: 4080000n, from: ZERO, to: USER, block: HEAD + 50n });
    const next = await scanHoldings(client, USER, { scannedTo: first.scannedTo, candidates: ["4072237"] }, HEAD + 100n);
    const queries = logCalls(fake);
    expect(queries).toHaveLength(1);
    expect(BigInt(queries[0]!.fromBlock)).toBe(HEAD - RESCAN_OVERLAP_BLOCKS);
    expect(BigInt(queries[0]!.toBlock)).toBe(HEAD + 100n);
    expect(next).toEqual({ scannedTo: (HEAD + 100n).toString(), candidates: ["4080000", "4072237"] });
  });

  it("splits a window when the RPC asks to narrow the block range", async () => {
    const fake = fakePosmRpc({ head: 1_000_000n, maxRange: 300_000n, transfers: [{ id: 3n, from: ZERO, to: USER, block: 900_000n }] });
    const state = await scanHoldings(clientOf(fake), USER, null, 1_000_000n);
    expect(state.candidates).toEqual(["3"]);
    expect(logCalls(fake).length).toBeGreaterThan(1);
  });

  it("throws on transport failures (the caller degrades)", async () => {
    const fake = ljWallet();
    fake.failNext("eth_getLogs", Object.assign(new Error("Too Many Requests"), { code: 429 }));
    await expect(scanHoldings(clientOf(fake), USER, null, HEAD)).rejects.toThrow();
  });
});
