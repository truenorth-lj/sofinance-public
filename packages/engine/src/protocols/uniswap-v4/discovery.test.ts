import { beforeEach, describe, expect, it } from "vitest";
import { createRhcClients, resetEvmRpcGuards } from "../../rpc-evm";
import { feeConfigUpdatedLog, mockRhcChain, mockRhcTransport, swapLog, upgradedLog, type MockRhcChain } from "../../test-support/rhc-mock-rpc";
import { STABLE_PAIR_HOOK, UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { discoverUniv4RhcPools, evaluatePool, readPoolHistory, readPoolState, type RawPoolHistory } from "./discovery";

const SPCX = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const clientsFor = (chain: MockRhcChain) => createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });

beforeEach(() => resetEvmRpcGuards());

describe("uniswap-v4-rhc discovery (mock RPC replaying the 2026-10-29 capture)", () => {
  it("lists SPCX/SPCXon with live state, dynamic fee, metadata and price vs reference", async () => {
    const chain = mockRhcChain();
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(chain) });
    expect(pool).toMatchObject({
      protocol: "uniswap-v4-rhc", chainId: 4663, poolId: SPCX.poolId, status: "listed", delistReasons: [],
      token0: { symbol: "SPCX", decimals: 18, issuer: "robinhood" }, token1: { symbol: "SPCXon", decimals: 18, issuer: "ondo" },
      hookImplementation: STABLE_PAIR_HOOK.implementation, tick: -1, liquidity: "114958581440704952836431",
      dynamicFeePips: { zeroForOne: 50, oneForZero: 51 }, protocolFee: 0, referencePrice: 1, historyScannedTo: "100701103", warnings: [],
    });
    expect(pool!.checks.every(check => check.ok === true)).toBe(true);
    expect(pool!.price).toBeCloseTo(0.99999965, 7);
    expect(pool!.priceVsReferenceBps).toBeCloseTo(-0.0035, 3);
    expect(pool!.apr?.activeLiquidityFromRanges).toBe(pool!.liquidity);
    // State: 1 block + 1 multicall + 1 storage read; history: 4 single-topic getLogs.
    expect(chain.calls.map(call => call.method).sort()).toEqual(["eth_call", "eth_getBlockByNumber", "eth_getLogs", "eth_getLogs", "eth_getLogs", "eth_getLogs", "eth_getStorageAt"]);
    for (const call of chain.calls.filter(call => call.method === "eth_getLogs")) {
      const [filter] = call.params as [{ topics: unknown[] }];
      expect(filter.topics.every(topic => !Array.isArray(topic))).toBe(true);
    }
  });

  it("auto-delists when the hook implementation changes", async () => {
    const chain = mockRhcChain();
    chain.implementation = "0x000000000000000000000000000000000000dEaD";
    chain.logs.push(upgradedLog(chain.implementation, chain.blockNumber - 10n));
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(chain) });
    expect(pool!.status).toBe("delisted");
    expect(pool!.delistReasons).toEqual(["hook-implementation", "upgrade-events"]);
  });

  it("auto-delists on an upgrade event even when it points back at the reviewed implementation", async () => {
    const chain = mockRhcChain();
    chain.logs.push(upgradedLog(STABLE_PAIR_HOOK.implementation, chain.blockNumber - 10n));
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(chain) });
    expect(pool!.delistReasons).toEqual(["upgrade-events"]);
  });

  it("auto-delists when the fee config changes or a FeeConfigUpdated is emitted", async () => {
    const changed = mockRhcChain();
    changed.feeConfig = [changed.feeConfig[0], 3000, changed.feeConfig[2], changed.feeConfig[3]];
    expect((await discoverUniv4RhcPools({ clients: clientsFor(changed) }))[0]!.delistReasons).toEqual(["fee-config"]);

    resetEvmRpcGuards();
    const event = mockRhcChain();
    event.logs.push(feeConfigUpdatedLog(event.blockNumber - 5n));
    expect((await discoverUniv4RhcPools({ clients: clientsFor(event) }))[0]!.delistReasons).toEqual(["fee-config-events"]);
  });

  it("fails closed when state is unreadable and only skips event checks when logs are", async () => {
    const down = mockRhcChain();
    down.failing = new Set(["eth_getBlockByNumber"]);
    const [dead] = await discoverUniv4RhcPools({ clients: clientsFor(down) });
    expect(dead!.status).toBe("delisted");
    expect(dead!.apr).toBeNull();

    resetEvmRpcGuards();
    const noLogs = mockRhcChain();
    noLogs.failing = new Set(["eth_getLogs"]);
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(noLogs) });
    expect(pool!.status).toBe("listed");
    expect(pool!.apr).toBeNull();
    expect(pool!.checks.filter(check => check.ok === null).map(check => check.id)).toEqual(["fee-config-events", "upgrade-events"]);
  });

  it("delists on unexpected token metadata or hook-reported state", async () => {
    const chain = mockRhcChain();
    chain.tokens[SPCX.currency1.address.toLowerCase()]!.decimals = 6;
    chain.sqrtPriceX96 = 0n;
    const state = await readPoolState(clientsFor(chain).state, SPCX);
    expect(evaluatePool(SPCX, state, null).delistReasons).toEqual(["initialized", "token-metadata"]);
  });

  it("extends history incrementally and keeps only swaps in the APR window", async () => {
    const chain = mockRhcChain();
    chain.maxLogSpan = 2_500_000n;
    const clients = clientsFor(chain);
    const first = await readPoolHistory(clients.logs, SPCX, { toBlock: chain.blockNumber, swapsFromBlock: 100_000_000n, maxRequests: 40 });
    expect(first.swaps.map(swap => swap.blockNumber)).toEqual([100172742n, 100174634n, 100299802n]);
    expect(first.ranges).toHaveLength(2);
    expect(first.upgrades).toHaveLength(1);

    resetEvmRpcGuards();
    chain.calls = [];
    chain.blockNumber += 100n;
    chain.logs.push(swapLog({ blockNumber: chain.blockNumber - 1n, amount0: -1_000_000n, amount1: 999_950n, liquidity: chain.liquidity, tick: -1, fee: 50 }));
    const next: RawPoolHistory = await readPoolHistory(clients.logs, SPCX, { toBlock: chain.blockNumber, swapsFromBlock: 100_200_000n, previous: first });
    expect(next.swaps.map(swap => swap.blockNumber)).toEqual([100299802n, chain.blockNumber - 1n]);
    expect(next.ranges).toEqual(first.ranges);
    expect(next.upgrades).toEqual(first.upgrades);
    const [filter] = chain.calls[0]!.params as [{ fromBlock: string }];
    expect(BigInt(filter.fromBlock)).toBe(first.scannedTo + 1n);
  });
});
