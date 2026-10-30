import { beforeEach, describe, expect, it } from "vitest";
import dexScreenerCapture from "../../fixtures/univ4-rhc-spcx-dexscreener.json";
import { createRhcClients, resetEvmRpcGuards } from "../../rpc-evm";
import { mockRhcChain, mockRhcTransport, upgradedLog, type MockRhcChain } from "../../test-support/rhc-mock-rpc";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { discoverUniv4RhcPools, evaluatePool, readPoolState } from "./discovery";
import { parseDexScreenerPair } from "./market-data";

const SPCX = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const clientsFor = (chain: MockRhcChain) => createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });
const market = parseDexScreenerPair(dexScreenerCapture, SPCX)!;

beforeEach(() => resetEvmRpcGuards());

describe("uniswap-v4-rhc discovery (mock RPC replaying the 2026-10-29 capture)", () => {
  it("lists SPCX/SPCXon from current state only, with APR from the indexer's 24h volume / TVL", async () => {
    const chain = mockRhcChain();
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(chain), marketData: async () => market });
    expect(pool).toMatchObject({
      protocol: "uniswap-v4-rhc", chainId: 4663, poolId: SPCX.poolId, status: "listed", delistReasons: [],
      token0: { symbol: "SPCX", decimals: 18, issuer: "robinhood" }, token1: { symbol: "SPCXon", decimals: 18, issuer: "ondo" },
      tick: -1, liquidity: "114958581440704952836431", dynamicFeePips: { zeroForOne: 50, oneForZero: 51 }, protocolFee: 0, referencePrice: 1, warnings: [],
      estimatedApr: { estimated: true, basis: "24h-volume", source: "dexscreener", volume24hUsd: 36.54, tvlUsd: 48711.43, txns24h: 3 },
    });
    expect(pool!.checks.map(check => check.id)).toEqual(["pool-id", "pool-key", "initialized", "hook-permissions", "hook-implementation", "fee-config", "token-metadata"]);
    expect(pool!.checks.every(check => check.ok === true)).toBe(true);
    expect(pool!.price).toBeCloseTo(0.99999965, 7);
    // Both tokens: issuer can pause / blocklist / burn / upgrade → shown like a Solana freeze authority.
    expect(pool!.freezeRisk).toBe(true);
    expect(pool!.tokenControls).toMatchObject([
      { symbol: "SPCX", reviewed: true, paused: false, powers: ["pause", "blocklist", "admin-burn", "upgradeable"] },
      { symbol: "SPCXon", reviewed: true, paused: false, powers: ["pause", "blocklist", "admin-burn", "upgradeable"] },
    ]);
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
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(chain) });
    expect(pool!.status).toBe("delisted");
    expect(pool!.delistReasons).toEqual(["hook-implementation"]);
    expect(chain.calls.some(call => call.method === "eth_getLogs")).toBe(false);
  });

  it("auto-delists when the fee config values change", async () => {
    const changed = mockRhcChain();
    changed.feeConfig = [changed.feeConfig[0], 3000, changed.feeConfig[2], changed.feeConfig[3]];
    expect((await discoverUniv4RhcPools({ clients: clientsFor(changed) }))[0]!.delistReasons).toEqual(["fee-config"]);
  });

  it("fails closed when state is unreadable; a market-data failure only drops APR", async () => {
    const down = mockRhcChain();
    down.failing = new Set(["eth_getBlockByNumber"]);
    const [dead] = await discoverUniv4RhcPools({ clients: clientsFor(down), marketData: async () => market });
    expect(dead!.status).toBe("delisted");
    expect(dead!.estimatedApr).toBeNull();

    resetEvmRpcGuards();
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(mockRhcChain()), marketData: async () => { throw new Error("indexer down"); } });
    expect(pool!.status).toBe("listed");
    expect(pool!.estimatedApr).toBeNull();
  });

  it("warns when a token is paused or its controls change, without delisting", async () => {
    const chain = mockRhcChain();
    chain.pausedByManager[SPCX.currency1.address.toLowerCase()] = true;
    const beacon0 = Object.keys(chain.beaconImplementations).find(beacon => beacon === "0xe10b6f6b275de231345c20d14ab812db62151b00")!;
    chain.beaconImplementations[beacon0] = "0x000000000000000000000000000000000000dEaD";
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(chain) });
    expect(pool!.status).toBe("listed");
    expect(pool!.freezeRisk).toBe(true);
    expect(pool!.tokenControls.map(c => [c.symbol, c.reviewed, c.paused])).toEqual([["SPCX", false, false], ["SPCXon", true, true]]);
    expect(pool!.warnings).toEqual([
      "SPCX token contract could not be confirmed as the reviewed version",
      "SPCXon transfers are paused by its issuer right now",
    ]);
  });

  it("treats a registry-wide pause as paused and unreadable controls as unconfirmed", async () => {
    const chain = mockRhcChain();
    chain.pausedContracts["0xe10b6f6b275de231345c20d14ab812db62151b00"] = true;
    chain.pauseManagers = {};
    const [pool] = await discoverUniv4RhcPools({ clients: clientsFor(chain) });
    expect(pool!.tokenControls.map(c => [c.symbol, c.reviewed, c.paused])).toEqual([["SPCX", true, true], ["SPCXon", false, null]]);
  });

  it("delists on unexpected token metadata or hook-reported state", async () => {
    const chain = mockRhcChain();
    chain.tokens[SPCX.currency1.address.toLowerCase()]!.decimals = 6;
    chain.sqrtPriceX96 = 0n;
    const state = await readPoolState(clientsFor(chain).state, SPCX);
    expect(evaluatePool(SPCX, state, null).delistReasons).toEqual(["initialized", "token-metadata"]);
  });
});
