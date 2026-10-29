import {
  custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, numberToHex, pad, parseAbi, parseAbiParameters,
  type Abi, type Address, type Hex, type Transport,
} from "viem";
import fixture from "../fixtures/univ4-rhc-spcx-live.json";
import { MULTICALL3_ADDRESS } from "../chains/robinhood";
import { ERC20_METADATA_ABI, FEE_CONFIG_UPDATED_EVENT, MODIFY_LIQUIDITY_EVENT, STABLE_PAIR_HOOK_ABI, STATE_VIEW_ABI, SWAP_EVENT, UPGRADED_EVENT } from "../protocols/uniswap-v4/abi";
import { ERC1967_IMPLEMENTATION_SLOT, STABLE_PAIR_HOOK, UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "../protocols/uniswap-v4/constants";

/**
 * Mock Robinhood Chain JSON-RPC (EIP-1193) replaying the recorded SPCX/SPCXon capture
 * (`fixtures/univ4-rhc-spcx-live.json`). Serves exactly what discovery reads: latest block,
 * Multicall3 `aggregate3` over StateView / hook / ERC-20 calls, the ERC1967 slot and `eth_getLogs`.
 * Tests mutate `MockRhcChain` to simulate a hook upgrade, a fee-config change, outages or range caps.
 */
const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

const SPCX = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;

export type MockLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; logIndex: number };

export type MockRhcChain = {
  blockNumber: bigint;
  blockTimestamp: number;
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  liquidity: bigint;
  dynamicFee: [number, number];
  feeConfig: [number, number, number, bigint];
  implementation: Address;
  tokens: Record<string, { name: string; symbol: string; decimals: number }>;
  logs: MockLog[];
  /** Reject getLogs spanning more blocks than this, with the official RPC's message. */
  maxLogSpan?: bigint;
  /** Methods that fail outright (provider outage). */
  failing?: Set<string>;
  calls: { method: string; params: unknown }[];
};

const s = fixture.state, h = fixture.history;

export function swapLog(swap: { blockNumber: bigint | string; amount0: bigint | string; amount1: bigint | string; liquidity: bigint | string; tick: number; fee: number }, logIndex = 0): MockLog {
  return {
    address: UNIV4_RHC.poolManager,
    topics: encodeEventTopics({ abi: [SWAP_EVENT], args: { id: SPCX.poolId, sender: UNIV4_RHC.universalRouter } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"),
      [BigInt(swap.amount0), BigInt(swap.amount1), BigInt(s.slot0.sqrtPriceX96), BigInt(swap.liquidity), swap.tick, swap.fee]),
    blockNumber: BigInt(swap.blockNumber), logIndex,
  };
}

export function modifyLiquidityLog(range: { tickLower: number; tickUpper: number; liquidity: bigint | string }, blockNumber: bigint, logIndex = 0): MockLog {
  return {
    address: UNIV4_RHC.poolManager,
    topics: encodeEventTopics({ abi: [MODIFY_LIQUIDITY_EVENT], args: { id: SPCX.poolId, sender: UNIV4_RHC.positionManager } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("int24, int24, int256, bytes32"), [range.tickLower, range.tickUpper, BigInt(range.liquidity), pad("0x01")]),
    blockNumber, logIndex,
  };
}

export function feeConfigUpdatedLog(blockNumber: bigint): MockLog {
  return {
    address: STABLE_PAIR_HOOK.proxy,
    topics: encodeEventTopics({ abi: [FEE_CONFIG_UPDATED_EVENT], args: { poolId: SPCX.poolId } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("(uint24 k, uint24 optimalFeeE6, uint8 targetMultiplier, uint160 referenceSqrtPriceX96)"),
      [{ k: 1, optimalFeeE6: 3000, targetMultiplier: 1, referenceSqrtPriceX96: 2n ** 96n }]),
    blockNumber, logIndex: 0,
  };
}

export function upgradedLog(implementation: Address, blockNumber: bigint): MockLog {
  return {
    address: STABLE_PAIR_HOOK.proxy,
    topics: encodeEventTopics({ abi: [UPGRADED_EVENT], args: { implementation } }) as Hex[],
    data: "0x", blockNumber, logIndex: 0,
  };
}

/** Fresh chain matching the 2026-10-29 capture. */
export function mockRhcChain(): MockRhcChain {
  return {
    blockNumber: BigInt(s.blockNumber),
    blockTimestamp: s.blockTimestamp,
    sqrtPriceX96: BigInt(s.slot0.sqrtPriceX96),
    tick: s.slot0.tick,
    protocolFee: s.slot0.protocolFee,
    liquidity: BigInt(s.liquidity),
    dynamicFee: [s.dynamicFee.zeroForOne, s.dynamicFee.oneForZero],
    feeConfig: [s.feeConfig.k, s.feeConfig.optimalFeeE6, s.feeConfig.targetMultiplier, BigInt(s.feeConfig.referenceSqrtPriceX96)],
    implementation: getAddress(s.implementation),
    tokens: {
      [s.token0.address.toLowerCase()]: s.token0,
      [s.token1.address.toLowerCase()]: s.token1,
    },
    logs: [
      upgradedLog(getAddress(h.upgrades[0]!.implementation), BigInt(h.upgrades[0]!.blockNumber)),
      modifyLiquidityLog(h.ranges[0]!, 98434580n),
      modifyLiquidityLog(h.ranges[1]!, 100015793n),
      ...h.swaps.map(swap => swapLog(swap)),
    ],
    calls: [],
  };
}

type Call = { target: Address; callData: Hex };

function answer(chain: MockRhcChain, call: Call): Hex | null {
  const target = call.target.toLowerCase();
  const tryDecode = (abi: Abi) => { try { return decodeFunctionData({ abi, data: call.callData }); } catch { return null; } };
  if (target === UNIV4_RHC.stateView.toLowerCase()) {
    const decoded = tryDecode(STATE_VIEW_ABI);
    if (decoded?.functionName === "getSlot0") return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName: "getSlot0", result: [chain.sqrtPriceX96, chain.tick, chain.protocolFee, 0] });
    if (decoded?.functionName === "getLiquidity") return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName: "getLiquidity", result: chain.liquidity });
  }
  if (target === STABLE_PAIR_HOOK.proxy.toLowerCase()) {
    const decoded = tryDecode(STABLE_PAIR_HOOK_ABI);
    if (decoded?.functionName === "getFee") return encodeFunctionResult({ abi: STABLE_PAIR_HOOK_ABI, functionName: "getFee", result: chain.dynamicFee });
    if (decoded?.functionName === "feeConfig") return encodeFunctionResult({ abi: STABLE_PAIR_HOOK_ABI, functionName: "feeConfig", result: chain.feeConfig });
  }
  const token = chain.tokens[target];
  if (token) {
    const decoded = tryDecode(ERC20_METADATA_ABI);
    if (decoded?.functionName === "name") return encodeFunctionResult({ abi: ERC20_METADATA_ABI, functionName: "name", result: token.name });
    if (decoded?.functionName === "symbol") return encodeFunctionResult({ abi: ERC20_METADATA_ABI, functionName: "symbol", result: token.symbol });
    if (decoded?.functionName === "decimals") return encodeFunctionResult({ abi: ERC20_METADATA_ABI, functionName: "decimals", result: token.decimals });
  }
  return null;
}

type LogFilter = { address?: Address; topics?: (Hex | Hex[] | null)[]; fromBlock?: Hex; toBlock?: Hex };

export function mockRhcRequest(chain: MockRhcChain) {
  return async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    chain.calls.push({ method, params });
    if (chain.failing?.has(method)) throw new Error("upstream unavailable");
    const args = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId": return numberToHex(4663);
      case "eth_blockNumber": return numberToHex(chain.blockNumber);
      case "eth_getBlockByNumber": return {
        number: numberToHex(chain.blockNumber), timestamp: numberToHex(chain.blockTimestamp), hash: pad("0x01"), parentHash: pad("0x02"),
        transactions: [], gasLimit: "0x1", gasUsed: "0x0", baseFeePerGas: "0x1", difficulty: "0x0", logsBloom: pad("0x0", { size: 256 }),
        miner: getAddress("0x0000000000000000000000000000000000000001"), extraData: "0x", size: "0x1", stateRoot: pad("0x03"), receiptsRoot: pad("0x04"),
        transactionsRoot: pad("0x05"), sha3Uncles: pad("0x06"), uncles: [], nonce: "0x0000000000000000", mixHash: pad("0x07"), totalDifficulty: null,
      };
      case "eth_getStorageAt": {
        const [address, slot] = args as [Address, Hex];
        if (address.toLowerCase() === STABLE_PAIR_HOOK.proxy.toLowerCase() && slot.toLowerCase() === ERC1967_IMPLEMENTATION_SLOT)
          return pad(chain.implementation);
        return pad("0x0");
      }
      case "eth_call": {
        const [tx] = args as [{ to: Address; data: Hex }];
        if (tx.to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) {
          const direct = answer(chain, { target: tx.to, callData: tx.data });
          if (direct === null) throw new Error("execution reverted");
          return direct;
        }
        const { args: [calls] } = decodeFunctionData({ abi: MULTICALL3_ABI, data: tx.data }) as { args: readonly [readonly Call[]] };
        return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: calls.map(call => {
          const data = answer(chain, call);
          return { success: data !== null, returnData: data ?? "0x" };
        }) });
      }
      case "eth_getLogs": {
        const [filter] = args as [LogFilter];
        const from = BigInt(filter.fromBlock ?? "0x0"), to = BigInt(filter.toBlock ?? numberToHex(chain.blockNumber));
        if (chain.maxLogSpan !== undefined && to - from + 1n > chain.maxLogSpan)
          throw new Error(`query spans ${to - from + 1n} blocks, only ${chain.maxLogSpan} are allowed`);
        return chain.logs.filter(log => {
          if (log.blockNumber < from || log.blockNumber > to) return false;
          if (filter.address && filter.address.toLowerCase() !== log.address.toLowerCase()) return false;
          return (filter.topics ?? []).every((topic, i) => topic === null || topic === undefined
            || (Array.isArray(topic) ? topic.map(t => t.toLowerCase()).includes(log.topics[i]?.toLowerCase() as Hex) : topic.toLowerCase() === log.topics[i]?.toLowerCase()));
        }).map(log => ({
          address: log.address, topics: log.topics, data: log.data, blockNumber: numberToHex(log.blockNumber), logIndex: numberToHex(log.logIndex),
          transactionIndex: "0x0", transactionHash: pad(numberToHex(log.blockNumber)), blockHash: pad("0x01"), removed: false,
        }));
      }
      default: throw new Error(`mock RPC: unsupported ${method}`);
    }
  };
}

export const mockRhcTransport = (chain: MockRhcChain): Transport => custom({ request: mockRhcRequest(chain) }, { retryCount: 0 });
