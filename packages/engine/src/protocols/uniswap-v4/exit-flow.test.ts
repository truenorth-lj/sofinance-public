import { type Hex, pad, toHex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { analyseExitLogs, decodePositionInfo, lookupPositions, prepareExit } from "./exit-flow";
import { TRANSFER_TOPIC } from "./open-abi";
import { checkExitPlan } from "./tx-exit-posm";

const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const USER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const FEE = "0x1111111111111111111111111111111111111111" as const;
const ID = 4077059n;
const LIQ = 29_340_323_272_345_554_694n;
const OUT0 = 13215253191957454n, OUT1 = 16116196738446847n;
const NOW = 1_800_000_000n;
const info = (lower: number, upper: number) => (BigInt.asUintN(24, BigInt(upper)) << 32n) | (BigInt.asUintN(24, BigInt(lower)) << 8n);
const topic = (a: string) => pad(a as Hex, { size: 32 });
const erc20 = (token: string, from: string, to: string, amount: bigint) => ({ address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: toHex(amount, { size: 32 }) });
const nftBurn = (id = ID, from: string = USER) => ({ address: UNIV4_RHC.positionManager, topics: [TRANSFER_TOPIC, topic(from), topic("0x0000000000000000000000000000000000000000"), toHex(id, { size: 32 })], data: "0x" });
const okLogs = () => [erc20(pool.currency0.address, UNIV4_RHC.poolManager, USER, OUT0), erc20(pool.currency1.address, UNIV4_RHC.poolManager, USER, OUT1), nftBurn()];

type Fake = { owner?: string | null; key?: Record<string, unknown>; sim?: (data: Hex, n: number) => { status: Hex; gasUsed: Hex; returnData: Hex; logs: unknown[]; error?: unknown };
  balance?: bigint; estimate?: bigint | Error; rpcDown?: boolean };

function fakeClient(f: Fake = {}) {
  const sims: Hex[] = [];
  const key = f.key ?? { currency0: pool.currency0.address, currency1: pool.currency1.address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks };
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (f.rpcDown) throw new Error("fetch failed");
      if (functionName === "ownerOf") { if (f.owner === null) throw Object.assign(new Error("execution reverted"), { name: "ContractFunctionExecutionError" }); return f.owner ?? USER; }
      if (functionName === "getPositionLiquidity") return LIQ;
      return [key, info(-11, 9)];
    },
    getBlock: async () => ({ number: 100_997_267n, timestamp: NOW }),
    request: async ({ method, params }: { method: string; params: [{ blockStateCalls: [{ calls: [{ data: Hex; from: string; to: string }] }] }] }) => {
      expect(method).toBe("eth_simulateV1");
      const call = params[0].blockStateCalls[0].calls[0];
      expect(call.from.toLowerCase()).toBe(USER.toLowerCase());
      expect(call.to).toBe(UNIV4_RHC.positionManager);
      sims.push(call.data);
      return [{ calls: [f.sim ? f.sim(call.data, sims.length) : { status: "0x1", gasUsed: toHex(216_652n), returnData: "0x", logs: okLogs() }] }];
    },
    getGasPrice: async () => 20_654_000n,
    getBalance: async () => f.balance ?? 10n ** 16n,
    estimateGas: async () => { if (f.estimate instanceof Error) throw f.estimate; return f.estimate ?? 258_564n; },
  } as unknown as PublicClient;
  return { client, sims };
}

describe("decodePositionInfo", () => {
  it("unpacks signed ticks and the subscriber flag", () => {
    expect(decodePositionInfo(info(-11, 9))).toEqual({ tickLower: -11, tickUpper: 9, hasSubscriber: false });
    expect(decodePositionInfo(info(-887_220, 887_220) | 1n)).toEqual({ tickLower: -887_220, tickUpper: 887_220, hasSubscriber: true });
  });
});

describe("prepareExit", () => {
  it("simulates from the owner, sets 50 bps mins from the simulated amounts, and returns a guarded unsigned tx (no fee)", async () => {
    const { client, sims } = fakeClient();
    const r = await prepareExit({ client, feeRecipient: FEE }, { user: USER, tokenId: ID });
    if (r.state !== "ready") throw new Error(r.message);
    expect(sims).toHaveLength(2);
    expect(r.expected).toEqual({ amount0: OUT0.toString(), amount1: OUT1.toString() });
    expect(r.min).toEqual({ amount0: "13149176925997666", amount1: "16035615754754612" });
    expect(r.slippageBps).toBe(50);
    expect(r.tx).toMatchObject({ to: UNIV4_RHC.positionManager, value: "0x0", chainId: 4663, gasLimit: "323205" });
    expect(r.tx.from.toLowerCase()).toBe(USER.toLowerCase());
    expect(r.gas).toEqual({ estimate: "258564", limit: "323205", gasPrice: "20654000", maxCostWei: (323_205n * 20_654_000n).toString() });
    expect(r.position).toMatchObject({ tokenId: "4077059", ownedByUser: true, tickLower: -11, tickUpper: 9, poolId: pool.poolId, liquidity: LIQ.toString() });
    expect(r.simulation).toMatchObject({ burned: true, otherTransfers: [] });
    expect(r.deadline).toBe((NOW + 600n).toString());
    const decoded = checkExitPlan({ tx: r.tx, pool, user: USER, tokenId: ID, feeRecipient: FEE });
    expect(decoded.amount0Min).toBe(13149176925997666n);
    expect(sims[1]).toBe(r.tx.data);
  });
  it("still closes a position when no fee wallet is configured (exit never needs it)", async () => {
    expect((await prepareExit({ client: fakeClient().client }, { user: USER, tokenId: ID })).state).toBe("ready");
  });
  it.each([
    ["not-found", { owner: null }, /does not exist or is already closed/],
    ["not-owner", { owner: OTHER }, /belongs to another wallet \(0x2222…2222\)/],
    ["pool-not-allowlisted", { key: { currency0: pool.currency0.address, currency1: pool.currency1.address, fee: 3000, tickSpacing: 60, hooks: pool.hooks } }, /not in a pool SoFinance supports/],
    ["rpc", { rpcDown: true }, /Could not read Robinhood Chain/],
    ["insufficient-gas", { balance: 1000n }, /Not enough ETH on Robinhood Chain to pay the gas for closing .*Add some ETH/],
    ["insufficient-gas", { estimate: new Error("insufficient funds for gas * price + value") }, /Not enough ETH/],
    ["simulation-check", { sim: () => ({ status: "0x1", gasUsed: "0x1", returnData: "0x", logs: [...okLogs(), erc20(pool.currency0.address, USER, FEE, 1n)] }) }, /No fee on exit/],
    ["simulation-check", { sim: () => ({ status: "0x1", gasUsed: "0x1", returnData: "0x", logs: okLogs().slice(0, 2) }) }, /did not close \(burn\)/],
    ["simulation-reverted", { sim: () => ({ status: "0x0", gasUsed: "0x1", returnData: "0x0ca968d8" + "0".repeat(56) + "", logs: [] }) }, /not allowed to close/],
  ])("fails with %s in plain words", async (expected, fake, message) => {
    const r = await prepareExit({ client: fakeClient(fake as Fake).client, feeRecipient: FEE }, { user: USER, tokenId: ID });
    expect(r).toMatchObject({ state: "failed", code: expected });
    if (r.state === "failed") expect(r.message).toMatch(message);
  });
});

describe("lookupPositions", () => {
  it("reads each NFT id (dedup, max 10), marking ownership and missing ids", async () => {
    const owned = await lookupPositions(fakeClient().client, USER, [ID, ID]);
    expect(owned).toEqual([{ tokenId: "4077059", position: expect.objectContaining({ ownedByUser: true, poolId: pool.poolId, baseSymbol: pool.baseSymbol }) }]);
    expect((await lookupPositions(fakeClient({ owner: OTHER }).client, USER, [ID]))[0]!.position).toMatchObject({ ownedByUser: false });
    expect(await lookupPositions(fakeClient({ owner: null }).client, USER, [1n])).toEqual([{ tokenId: "1", position: null, error: "not-found" }]);
    expect(await lookupPositions(fakeClient({ rpcDown: true }).client, USER, [1n])).toEqual([{ tokenId: "1", position: null, error: "rpc" }]);
    expect(await lookupPositions(fakeClient().client, USER, Array.from({ length: 15 }, (_, i) => BigInt(i + 1)))).toHaveLength(10);
  });
});

describe("analyseExitLogs", () => {
  it("sums tokens to the owner, detects the burn and flags anything else", () => {
    expect(analyseExitLogs(okLogs() as never, pool, USER, ID, FEE)).toEqual({ amount0: OUT0, amount1: OUT1, burned: true, feeWalletTouched: false, other: [] });
    const bad = analyseExitLogs([...okLogs(), erc20(pool.currency1.address, UNIV4_RHC.poolManager, OTHER, 5n)] as never, pool, USER, ID, FEE);
    expect(bad.other).toHaveLength(1);
  });
});
