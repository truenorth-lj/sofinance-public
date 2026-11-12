import { createPublicClient } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import dexScreenerCapture from "../../fixtures/univ4-rhc-spcx-dexscreener.json";
import { robinhoodChain } from "../../chains/robinhood";
import { createRhcClients, resetEvmRpcGuards } from "../../rpc-evm";
import { mockRhcChain, mockRhcTransport, upgradedLog, type MockRhcChain } from "../../test-support/rhc-mock-rpc";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { discoverUniv4RhcPools, evaluatePool, readPoolState, readPoolStates, type RawPoolState } from "./discovery";
import { parseDexScreenerPair } from "./market-data";

const SPCX = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const clientsFor = (chain: MockRhcChain) => createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });
const market = parseDexScreenerPair(dexScreenerCapture, SPCX)!;

beforeEach(() => resetEvmRpcGuards());

describe("uniswap-v4-rhc discovery (mock RPC replaying the 2026-10-29 capture)", () => {
  it("lists SPCX/SPCXon from current state only, with APR from the indexer's 24h volume / TVL", async () => {
    const chain = mockRhcChain();
    const [pool] = await discoverUniv4RhcPools({ pools: [SPCX], clients: clientsFor(chain), marketData: async () => market });
    expect(pool).toMatchObject({
      protocol: "uniswap-v4-rhc", chainId: 4663, poolId: SPCX.poolId, status: "listed", delistReasons: [],
      token0: { symbol: "SPCX", decimals: 18, issuer: "robinhood" }, token1: { symbol: "SPCXon", decimals: 18, issuer: "ondo" },
      tick: -1, liquidity: "114958581440704952836431", dynamicFeePips: { zeroForOne: 50, oneForZero: 51 }, protocolFee: 0, referencePrice: 1, warnings: [],
      estimatedApr: { estimated: true, basis: "24h-volume", source: "dexscreener", volume24hUsd: 36.54, tvlUsd: 48711.43, txns24h: 3 },
    });
    expect(pool!.checks.map(check => check.id)).toEqual(["pool-id", "pool-key", "initialized", "hook-permissions", "hook-implementation", "fee-config", "token-metadata"]);
    expect(pool!.checks.every(check => check.ok === true)).toBe(true);
    expect(pool!.price).toBeCloseTo(0.99999965, 7);
    // 50.5 pips × $36.54 / $48,711.43 × 365 ≈ 0.00138 %.
    expect(pool!.estimatedApr!.feeRatePct).toBeCloseTo(0.00505, 6);
    expect(pool!.estimatedApr!.estimatedPoolFeeAprPct).toBeCloseTo(0.00505 / 100 * 36.54 / 48711.43 * 365 * 100, 9);
    // RPC: 1 block + 1 multicall + 1 storage read; never eth_getLogs.
    expect(chain.calls.map(call => call.method).sort()).toEqual(["eth_call", "eth_getBlockByNumber", "eth_getStorageAt"]);
  });

  it("auto-delists from current state when the hook implementation changes (no event scan needed)", async () => {
    const chain = mockRhcChain();
    chain.implementation = "0x000000000000000000000000000000000000dEaD";
    chain.logs.push(upgradedLog(chain.implementation, chain.blockNumber - 10n));
    const [pool] = await discoverUniv4RhcPools({ pools: [SPCX], clients: clientsFor(chain) });
    expect(pool!.status).toBe("delisted");
    expect(pool!.delistReasons).toEqual(["hook-implementation"]);
    expect(chain.calls.some(call => call.method === "eth_getLogs")).toBe(false);
  });

  it("auto-delists when the fee config values change", async () => {
    const changed = mockRhcChain();
    changed.feeConfig = [changed.feeConfig[0], 3000, changed.feeConfig[2], changed.feeConfig[3]];
    expect((await discoverUniv4RhcPools({ pools: [SPCX], clients: clientsFor(changed) }))[0]!.delistReasons).toEqual(["fee-config"]);
  });

  it("fails closed when state is unreadable; a market-data failure only drops APR", async () => {
    const down = mockRhcChain();
    down.failing = new Set(["eth_getBlockByNumber"]);
    const [dead] = await discoverUniv4RhcPools({ pools: [SPCX], clients: clientsFor(down), marketData: async () => market });
    expect(dead!.status).toBe("delisted");
    expect(dead!.estimatedApr).toBeNull();

    resetEvmRpcGuards();
    const [pool] = await discoverUniv4RhcPools({ pools: [SPCX], clients: clientsFor(mockRhcChain()), marketData: async () => { throw new Error("indexer down"); } });
    expect(pool!.status).toBe("listed");
    expect(pool!.estimatedApr).toBeNull();
  });

  it("delists on unexpected token metadata or hook-reported state", async () => {
    const chain = mockRhcChain();
    chain.tokens[SPCX.currency1.address.toLowerCase()]!.decimals = 6;
    chain.sqrtPriceX96 = 0n;
    const state = await readPoolState(clientsFor(chain).state, SPCX);
    expect(evaluatePool(SPCX, state, null).delistReasons).toEqual(["initialized", "token-metadata"]);
  });

  it("keeps the indexer's token USD prices from the same market read (stored by the cron; no extra call)", async () => {
    const state = await readPoolState(clientsFor(mockRhcChain()).state, SPCX);
    const market = { source: "geckoterminal" as const, volume24hUsd: 10, tvlUsd: 100, txns24h: null, reserves: null, priceUsd: { token0: 140.32, token1: 140.33 } };
    expect(evaluatePool(SPCX, state, market).tokenPricesUsd).toEqual({ token0: 140.32, token1: 140.33 });
    expect(evaluatePool(SPCX, state, { ...market, priceUsd: null }).tokenPricesUsd).toBeNull();
    expect(evaluatePool(SPCX, state, null).tokenPricesUsd).toBeNull();
  });
});

describe("readPoolStates (batched) matches per-pool readPoolState on the pinned 2026-10-29 fixture", () => {
  it("returns identical values for all 11 allowlisted pools and uses 3 RPC requests instead of 33", async () => {
    const chain = mockRhcChain();
    // Distinct per-pool ticks and liquidity so a crossed result cannot pass by accident.
    chain.poolState = Object.fromEntries(UNIV4_RHC_ALLOWLISTED_POOLS.map((spec, index) => [spec.poolId.toLowerCase(), {
      tick: spec.baseSymbol === "SPCX" ? chain.tick : index + 2,
      liquidity: chain.liquidity + BigInt(index) * 10n ** 15n,
      dynamicFee: [50 + index, 51 + index] as [number, number],
    }]));
    // Raw viem clients (no process-local token bucket): 33 sequential reads would overflow official's burst of 6.
    const raw = (target: typeof chain) => createPublicClient({ chain: robinhoodChain, transport: mockRhcTransport(target), batch: { multicall: false } });
    const expected: RawPoolState[] = [];
    for (const spec of UNIV4_RHC_ALLOWLISTED_POOLS) expected.push(await readPoolState(raw(chain), spec));
    const perPoolCalls = chain.calls.length;
    expect(perPoolCalls).toBe(UNIV4_RHC_ALLOWLISTED_POOLS.length * 3);

    const batchedChain = mockRhcChain();
    batchedChain.poolState = chain.poolState;
    const { states, rpcRequests } = await readPoolStates(raw(batchedChain), UNIV4_RHC_ALLOWLISTED_POOLS);
    expect(states).toEqual(expected);
    expect(rpcRequests).toBe(3);
    expect(batchedChain.calls.map(call => call.method).sort()).toEqual(["eth_call", "eth_getBlockByNumber", "eth_getStorageAt"]);
    expect(batchedChain.calls).toHaveLength(3);
    expect(states[0]!.slot0!.tick).toBe(chain.tick);
    expect(states[1]!.slot0!.tick).toBe(3);
    expect(states.every(state => state.blockNumber === expected[0]!.blockNumber)).toBe(true);

    const stats: { rpcRequests: number; pools: number }[] = [];
    await discoverUniv4RhcPools({ pools: UNIV4_RHC_ALLOWLISTED_POOLS, clients: createRhcClients({ env: {}, transportFor: () => mockRhcTransport(mockRhcChain()) }), onStateRpc: s => stats.push(s) });
    expect(stats).toEqual([{ rpcRequests: 3, pools: 11 }]);
  });
});
