import {
  type Address, decodeFunctionData, encodeFunctionResult, type Hex, multicall3Abi, pad, toHex, type EIP1193RequestFn,
} from "viem";
import { MULTICALL3_ADDRESS } from "../../../chains/robinhood";
import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "../constants";
import { POSITION_MANAGER_READ_ABI, TRANSFER_TOPIC } from "../open-abi";

/**
 * Test-only fake of the official Robinhood Chain RPC for the PositionManager holdings scan: eth_blockNumber,
 * address-filtered eth_getLogs with the 10M-block cap, and Multicall3 `aggregate3` over ownerOf /
 * getPositionLiquidity / getPoolAndPositionInfo. Records every call.
 */
export type FakeNft = { id: bigint; owner: Address | null; liquidity?: bigint; hooks?: Address; tickLower?: number; tickUpper?: number; currency0?: Address };
export type FakeTransfer = { id: bigint; from: Address; to: Address; block: bigint; logIndex?: number };
export type FakePosmRpc = {
  head: bigint;
  nfts: Map<string, FakeNft>;
  transfers: FakeTransfer[];
  calls: { method: string; params?: unknown }[];
  request: EIP1193RequestFn;
  /** Throw this error for the next matching method (once). */
  failNext: (method: string, error: Error) => void;
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const word = (a: string) => pad(a.toLowerCase() as Hex, { size: 32 }).toLowerCase();
const info = (lower: number, upper: number) => (BigInt.asUintN(24, BigInt(upper)) << 32n) | (BigInt.asUintN(24, BigInt(lower)) << 8n);

export function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function fakePosmRpc(options: { head: bigint; maxRange?: bigint; nfts?: FakeNft[]; transfers?: FakeTransfer[] }): FakePosmRpc {
  const maxRange = options.maxRange ?? 10_000_000n;
  const nfts = new Map((options.nfts ?? []).map(n => [n.id.toString(), n]));
  const transfers = options.transfers ?? [];
  const calls: FakePosmRpc["calls"] = [];
  const failures: { method: string; error: Error }[] = [];
  const fake: FakePosmRpc = {
    head: options.head, nfts, transfers, calls,
    failNext: (method, error) => { failures.push({ method, error }); },
    request: (async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params });
      const f = failures.findIndex(x => x.method === method);
      if (f >= 0) throw failures.splice(f, 1)[0]!.error;
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_blockNumber") return toHex(fake.head);
      if (method === "eth_getLogs") {
        const [q] = params as [{ address: string; fromBlock: Hex; toBlock: Hex; topics: (string | null)[] }];
        const from = BigInt(q.fromBlock), to = BigInt(q.toBlock);
        if (to - from + 1n > maxRange) throw rpcError(-32602, `query spans ${to - from + 1n} blocks (${from} to ${to}), but only ${maxRange} are allowed for this request; narrow the block range`);
        if (q.address.toLowerCase() !== UNIV4_RHC.positionManager.toLowerCase()) return [];
        const [t0, t1, t2] = q.topics;
        return fake.transfers.filter(t => t.block >= from && t.block <= to)
          .filter(t => (!t1 || word(t.from) === t1.toLowerCase()) && (!t2 || word(t.to) === t2.toLowerCase()) && t0 === TRANSFER_TOPIC)
          .map(t => ({ address: UNIV4_RHC.positionManager, blockNumber: toHex(t.block), logIndex: toHex(t.logIndex ?? 0), transactionHash: `0x${"ab".repeat(32)}`,
            topics: [TRANSFER_TOPIC, word(t.from), word(t.to), toHex(t.id, { size: 32 })], data: "0x", removed: false }));
      }
      if (method === "eth_call") {
        const [tx] = params as [{ to: string; data: Hex }];
        if (tx.to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) throw rpcError(-32000, "unexpected eth_call target");
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
        const results = (args[0] as readonly { target: Address; callData: Hex }[]).map(c => {
          const { functionName, args: a } = decodeFunctionData({ abi: POSITION_MANAGER_READ_ABI, data: c.callData });
          const n = nfts.get(String(a[0]));
          if (!n || n.owner === null) return { success: false, returnData: "0x" as Hex }; // NOT_MINTED / burned
          if (functionName === "ownerOf") return { success: true, returnData: encodeFunctionResult({ abi: POSITION_MANAGER_READ_ABI, functionName, result: n.owner }) };
          if (functionName === "getPositionLiquidity") return { success: true, returnData: encodeFunctionResult({ abi: POSITION_MANAGER_READ_ABI, functionName, result: n.liquidity ?? 1n }) };
          return { success: true, returnData: encodeFunctionResult({ abi: POSITION_MANAGER_READ_ABI, functionName: "getPoolAndPositionInfo", result: [
            { currency0: n.currency0 ?? pool.currency0.address, currency1: pool.currency1.address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: n.hooks ?? pool.hooks },
            info(n.tickLower ?? -21, n.tickUpper ?? 19)] }) };
        });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
      }
      throw rpcError(-32601, `method ${method} not supported by the fake`);
    }) as EIP1193RequestFn,
  };
  return fake;
}

export { ZERO as FAKE_ZERO_ADDRESS };
