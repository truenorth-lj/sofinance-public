import { type Address, getAddress, isAddressEqual, pad, type PublicClient } from "viem";
import { STABLE_PAIR_HOOK, UNIV4_RHC } from "./constants";
import { decodePositionInfo, type PositionLookup, poolFor, positionView } from "./exit-flow";
import { POSITION_MANAGER_READ_ABI, TRANSFER_TOPIC } from "./open-abi";

/**
 * Wallet holdings scan for Robinhood Chain Uniswap v4 positions (LJ: positions come from the wallet's on-chain
 * holdings, like Raydium; no "opened through SoFinance" requirement). The v4 PositionManager is not enumerable, so the
 * held NFT ids come from its ERC-721 `Transfer` logs filtered by topic (to = wallet), in block windows no wider than
 * the official RPC allows, then every candidate is confirmed with `ownerOf` and read in one multicall.
 * Incremental: callers keep `HoldingsState` and later scans only cover blocks after `scannedTo`.
 */

/** Block of the first PositionManager mint (token #1, block 9506): nothing to scan before it. */
export const POSITION_MANAGER_FIRST_BLOCK = 9_506n;
/** The official RHC RPC caps an address-filtered eth_getLogs at 10M blocks (inclusive). */
export const MAX_LOG_BLOCK_RANGE = 10_000_000n;
/** Re-scan this many blocks below `scannedTo` on incremental scans (cheap; covers a shallow reorg). */
export const RESCAN_OVERLAP_BLOCKS = 64n;
/** Candidates confirmed per multicall (3 reads each). */
const MULTICALL_CHUNK = 40;
/** Most held positions read for one wallet. */
export const MAX_SCANNED_POSITIONS = 100;

/** `candidates`: NFT ids received by the wallet and not yet seen gone (burned or sent on); `scannedTo`: last block scanned. */
export type HoldingsState = { scannedTo: string; candidates: string[] };

export type ScannedPosition = PositionLookup & {
  /** Pool hook; `stablePair` = the Uniswap StablePairHook used by the Robinhood stock pairs. */
  hooks: Address | null;
  stablePair: boolean;
};

type RawLog = { address?: string; blockNumber: string | null; logIndex: string | null; topics: string[]; removed?: boolean };

const isRangeError = (error: unknown) => {
  const text = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : String(error);
  return /narrow the block range|block range|query returned more than|too many (results|logs)|limit exceeded|response size/i.test(text);
};

async function getLogs(client: PublicClient, topics: (string | null)[], from: bigint, to: bigint, depth = 0): Promise<RawLog[]> {
  try {
    return await client.request({
      method: "eth_getLogs",
      params: [{ address: UNIV4_RHC.positionManager as Address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics }],
    } as never) as RawLog[];
  } catch (error) {
    // A wallet with very many transfers, or a tighter limit later: split the window (bounded).
    if (depth >= 6 || to <= from || !isRangeError(error)) throw error;
    const mid = from + (to - from) / 2n;
    return [...await getLogs(client, topics, from, mid, depth + 1), ...await getLogs(client, topics, mid + 1n, to, depth + 1)];
  }
}

/** Block windows covering [from, to], each at most `MAX_LOG_BLOCK_RANGE` blocks. */
export function blockWindows(from: bigint, to: bigint, size = MAX_LOG_BLOCK_RANGE): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += size) out.push([s, s + size - 1n < to ? s + size - 1n : to]);
  return out;
}

/** Token ids from ERC-721 Transfer logs (4 topics) of the PositionManager whose `to` is the wallet. */
export function receivedTokenIds(logs: RawLog[], wallet: Address): string[] {
  const w = wallet.toLowerCase();
  const posm = UNIV4_RHC.positionManager.toLowerCase();
  return logs.filter(l => !l.removed && (!l.address || l.address.toLowerCase() === posm) && l.topics.length === 4
    && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && `0x${l.topics[2]!.slice(-40)}`.toLowerCase() === w)
    .map(l => BigInt(l.topics[3]!).toString());
}

const byIdDesc = (a: string, b: string) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0);

/**
 * Scans PositionManager Transfer logs with to = wallet over (state.scannedTo − overlap, head] (or from the first mint)
 * and adds the ids to the candidates. Only the incoming direction is queried: every candidate is confirmed with
 * `ownerOf` anyway, so an NFT sent or burned since drops out there, and querying `from = wallet` too would double the
 * calls on a rate-limited RPC without changing the result.
 */
export async function scanHoldings(client: PublicClient, wallet: Address, state: HoldingsState | null, head: bigint): Promise<HoldingsState> {
  const start = state ? (BigInt(state.scannedTo) > RESCAN_OVERLAP_BLOCKS ? BigInt(state.scannedTo) - RESCAN_OVERLAP_BLOCKS : 0n) : POSITION_MANAGER_FIRST_BLOCK;
  const from = start < POSITION_MANAGER_FIRST_BLOCK ? POSITION_MANAGER_FIRST_BLOCK : start;
  const ids = new Set(state?.candidates ?? []);
  if (from > head) return { scannedTo: state?.scannedTo ?? head.toString(), candidates: [...ids].sort(byIdDesc) };
  const topic = pad(wallet.toLowerCase() as Address, { size: 32 });
  // Sequential on purpose: the official RPC rate-limits bursts.
  for (const [s, e] of blockWindows(from, head)) for (const id of receivedTokenIds(await getLogs(client, [TRANSFER_TOPIC, null, topic], s, e), wallet)) ids.add(id);
  return { scannedTo: head.toString(), candidates: [...ids].sort(byIdDesc) };
}

/**
 * Confirms candidates with `ownerOf` and reads liquidity + pool key in multicalls (allowFailure: a burned NFT's
 * `ownerOf` reverts). Only NFTs the wallet owns now are returned; a failed read of a held NFT is `error: "rpc"`.
 */
export async function readHeldPositions(client: PublicClient, wallet: Address, tokenIds: string[]): Promise<ScannedPosition[]> {
  const ids = tokenIds.slice(0, MAX_SCANNED_POSITIONS).map(BigInt);
  const posm = UNIV4_RHC.positionManager as Address;
  const out: ScannedPosition[] = [];
  for (let i = 0; i < ids.length; i += MULTICALL_CHUNK) {
    const chunk = ids.slice(i, i + MULTICALL_CHUNK);
    const results = await client.multicall({
      allowFailure: true,
      contracts: chunk.flatMap(id => [
        { address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "ownerOf", args: [id] },
        { address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "getPositionLiquidity", args: [id] },
        { address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "getPoolAndPositionInfo", args: [id] },
      ] as const),
    });
    chunk.forEach((id, k) => {
      const [owner, liquidity, poolInfo] = [results[k * 3]!, results[k * 3 + 1]!, results[k * 3 + 2]!];
      if (owner.status !== "success" || !isAddressEqual(owner.result as Address, wallet)) return; // burned or moved on
      if (liquidity.status !== "success" || poolInfo.status !== "success") {
        out.push({ tokenId: id.toString(), position: null, error: "rpc", hooks: null, stablePair: false });
        return;
      }
      const [key, info] = poolInfo.result as readonly [{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, bigint];
      const { tickLower, tickUpper } = decodePositionInfo(info);
      const position = positionView({ tokenId: id, owner: getAddress(owner.result as Address), liquidity: liquidity.result as bigint, tickLower, tickUpper, pool: poolFor(key) }, wallet);
      out.push({ tokenId: id.toString(), position, hooks: getAddress(key.hooks), stablePair: isAddressEqual(key.hooks, STABLE_PAIR_HOOK.proxy as Address) });
    });
  }
  return out;
}
