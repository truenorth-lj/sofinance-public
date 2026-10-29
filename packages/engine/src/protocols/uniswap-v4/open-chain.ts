import {
  type Address, decodeAbiParameters, decodeFunctionResult, encodeFunctionData, type Hex, keccak256, numberToHex, type PublicClient, type StateOverride,
} from "viem";
import { UNIV4_RHC, type Univ4AllowlistedPool } from "./constants";
import { evaluatePool, poolKeyOf, readPoolState, type Univ4PoolSummary } from "./discovery";
import { ERC20_OPEN_ABI, KNOWN_REVERTS, PERMIT2_ABI, STATE_VIEW_TICKS_ABI, TRANSFER_TOPIC, V4_QUOTER_ABI } from "./open-abi";
import { EVM_FEE_RECIPIENT, OPEN_FEE_BPS, PINNED_UNIVERSAL_ROUTER, TICK_SCAN_WORDS } from "./open-constants";
import type { OpenPoolState, QuoteFn } from "./open-quote";

/**
 * Transaction-time chain access for the open path (PM 2026-10-29: RPC is used only here — pool state, quotes,
 * simulation, gas). All reads are at `latest`; nothing signs or sends.
 */

/** eth_simulateV1 / eth_call state override in JSON-RPC shape. Only tests and offline captures pass these. */
export type RpcStateOverrides = Record<Address, { balance?: Hex; stateDiff?: Record<Hex, Hex> }>;

export function toViemStateOverride(overrides: RpcStateOverrides | undefined): StateOverride | undefined {
  if (!overrides) return undefined;
  return Object.entries(overrides).map(([address, o]) => ({
    address: address as Address,
    ...(o.balance ? { balance: BigInt(o.balance) } : {}),
    ...(o.stateDiff ? { stateDiff: Object.entries(o.stateDiff).map(([slot, value]) => ({ slot: slot as Hex, value: value as Hex })) } : {}),
  }));
}

export type UserTokenState = {
  balance: bigint;
  /** ERC20 allowance user → Permit2 (Uniswap standard: MaxUint once). */
  erc20AllowanceToPermit2: bigint;
  /** Permit2 allowance user → pinned UR for the token (only `nonce` matters for a new PermitSingle). */
  permit2: { amount: bigint; expiration: number; nonce: number };
};

export type OpenContext = {
  blockNumber: bigint;
  nowSeconds: number;
  pool: Univ4PoolSummary;
  state: OpenPoolState;
  routerCodeHash: Hex | null;
  user: UserTokenState;
};

async function callDecode<T>(client: PublicClient, to: Address, data: Hex, decode: (raw: Hex) => T, stateOverride?: StateOverride): Promise<T> {
  const { data: raw } = await client.call({ to, data, blockTag: "latest", stateOverride });
  if (!raw) throw new Error(`empty eth_call result from ${to}`);
  return decode(raw);
}

/** Initialised ticks (+liquidityNet) within ±TICK_SCAN_WORDS bitmap words around the current tick (tickSpacing 1). */
export async function readTickWindow(client: PublicClient, pool: Univ4AllowlistedPool, tick: number, words = TICK_SCAN_WORDS): Promise<{ liquidityNet: Map<number, bigint>; scannedTicks: { lower: number; upper: number } }> {
  if (pool.tickSpacing !== 1) throw new Error("tick window scan assumes tickSpacing 1");
  const w0 = tick >> 8;
  const wordList = Array.from({ length: 2 * words + 1 }, (_, i) => w0 - words + i);
  const bitmaps = await client.multicall({
    allowFailure: false,
    contracts: wordList.map(w => ({ address: UNIV4_RHC.stateView, abi: STATE_VIEW_TICKS_ABI, functionName: "getTickBitmap", args: [pool.poolId, w] }) as const),
  });
  const initialised: number[] = [];
  bitmaps.forEach((bitmap, i) => {
    for (let bit = 0; bit < 256; bit++) if ((BigInt(bitmap) >> BigInt(bit)) & 1n) initialised.push(wordList[i]! * 256 + bit);
  });
  const liquidityNet = new Map<number, bigint>();
  if (initialised.length) {
    const nets = await client.multicall({
      allowFailure: false,
      contracts: initialised.map(t => ({ address: UNIV4_RHC.stateView, abi: STATE_VIEW_TICKS_ABI, functionName: "getTickLiquidity", args: [pool.poolId, t] }) as const),
    });
    nets.forEach((r, i) => liquidityNet.set(initialised[i]!, r[1]));
  }
  return { liquidityNet, scannedTicks: { lower: wordList[0]! * 256, upper: wordList.at(-1)! * 256 + 255 } };
}

export async function readUserTokenState(client: PublicClient, user: Address, token: Address, overrides?: RpcStateOverrides): Promise<UserTokenState> {
  const so = toViemStateOverride(overrides);
  const [balance, erc20AllowanceToPermit2, permit2] = await Promise.all([
    callDecode(client, token, encodeFunctionData({ abi: ERC20_OPEN_ABI, functionName: "balanceOf", args: [user] }),
      raw => decodeFunctionResult({ abi: ERC20_OPEN_ABI, functionName: "balanceOf", data: raw }), so),
    callDecode(client, token, encodeFunctionData({ abi: ERC20_OPEN_ABI, functionName: "allowance", args: [user, UNIV4_RHC.permit2] }),
      raw => decodeFunctionResult({ abi: ERC20_OPEN_ABI, functionName: "allowance", data: raw }), so),
    callDecode(client, UNIV4_RHC.permit2, encodeFunctionData({ abi: PERMIT2_ABI, functionName: "allowance", args: [user, token, PINNED_UNIVERSAL_ROUTER.address] }),
      raw => decodeFunctionResult({ abi: PERMIT2_ABI, functionName: "allowance", data: raw }), so),
  ]);
  return { balance, erc20AllowanceToPermit2, permit2: { amount: permit2[0], expiration: Number(permit2[1]), nonce: Number(permit2[2]) } };
}

/** Everything the planner needs, re-read at transaction time (listing checks included: a delisted pool cannot open). */
export async function readOpenContext(client: PublicClient, pool: Univ4AllowlistedPool, user: Address, tokenIn: Address, overrides?: RpcStateOverrides): Promise<OpenContext> {
  const raw = await readPoolState(client, pool);
  const summary = evaluatePool(pool, raw);
  if (!raw.slot0 || raw.liquidity === null) throw new Error("pool state unavailable");
  const [window, code, userState] = await Promise.all([
    readTickWindow(client, pool, raw.slot0.tick),
    client.getCode({ address: PINNED_UNIVERSAL_ROUTER.address, blockTag: "latest" }),
    readUserTokenState(client, user, tokenIn, overrides),
  ]);
  return {
    blockNumber: raw.blockNumber,
    nowSeconds: raw.blockTimestamp,
    pool: summary,
    state: { sqrtPriceX96: raw.slot0.sqrtPriceX96, tick: raw.slot0.tick, liquidity: raw.liquidity, ...window },
    routerCodeHash: code && code !== "0x" ? keccak256(code) : null,
    user: userState,
  };
}

export function decodeRevert(data: string | undefined | null): string {
  const hex = (data ?? "").toLowerCase();
  for (const [selector, name] of Object.entries(KNOWN_REVERTS)) if (hex.includes(selector.slice(2))) return name;
  return hex ? `unknown(${hex.slice(0, 10)})` : "unknown";
}

/** V4Quoter.quoteExactInputSingle via eth_call. NotEnoughLiquidity (possibly wrapped) → pool-depth. */
export function quoterFor(client: PublicClient, pool: Univ4AllowlistedPool): QuoteFn {
  return async (amountIn, zeroForOne) => {
    const data = encodeFunctionData({ abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [{ poolKey: poolKeyOf(pool), zeroForOne, exactAmount: amountIn, hookData: "0x" }] });
    try {
      const out = await callDecode(client, UNIV4_RHC.quoter as Address, data, raw => decodeFunctionResult({ abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", data: raw }));
      return { ok: true, amountOut: out[0] };
    } catch (error) {
      const reason = decodeRevert(revertDataOf(error));
      return reason === "NotEnoughLiquidity" ? { ok: false, reason: "pool-depth" } : { ok: false, reason: "quote-failed", detail: reason };
    }
  };
}

function revertDataOf(error: unknown): string {
  let e: unknown = error;
  for (let i = 0; i < 8 && e && typeof e === "object"; i++) {
    const data = (e as { data?: unknown }).data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") return (data as { data: string }).data;
    e = (e as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message : "";
}

export type SimCall = { from: Address; to: Address; data: Hex; value?: bigint };
export type SimCallResult = { status: "success" | "reverted"; gasUsed: bigint; returnData: Hex; revert: string | null; logs: SimLog[] };
export type SimLog = { address: Address; topics: Hex[]; data: Hex };

/** One eth_simulateV1 block at `latest`, validation off (no signatures or gas funding needed for the pre-sign path). */
export async function simulateCalls(client: PublicClient, calls: SimCall[], overrides?: RpcStateOverrides): Promise<SimCallResult[]> {
  const block: Record<string, unknown> = {
    calls: calls.map(c => ({ from: c.from, to: c.to, data: c.data, value: numberToHex(c.value ?? 0n) })),
  };
  if (overrides) block.stateOverrides = overrides;
  const result = await client.request({ method: "eth_simulateV1" as never, params: [{ blockStateCalls: [block], validation: false }, "latest"] as never }) as
    { calls: { status: Hex; gasUsed: Hex; returnData: Hex; logs?: SimLog[]; error?: { data?: string; message?: string } }[] }[];
  const out = result.at(-1)?.calls;
  if (!out || out.length !== calls.length) throw new Error("eth_simulateV1 returned an unexpected shape");
  return out.map(c => ({
    status: c.status === "0x1" ? "success" : "reverted",
    gasUsed: BigInt(c.gasUsed),
    returnData: c.returnData,
    revert: c.status === "0x1" ? null : decodeRevert(c.error?.data ?? c.returnData ?? c.error?.message),
    logs: c.logs ?? [],
  }));
}

export type OpenSimAnalysis = {
  swapOutput: bigint;
  feePaid: bigint;
  feeExpected: bigint;
  feeExact: boolean;
  feeOnDepositToken: bigint;
  refund0: bigint;
  refund1: bigint;
  nftTo: Address[];
  nftTokenId: bigint | null;
  nftToUser: boolean;
};

const topicAddress = (topic: Hex | undefined) => (`0x${(topic ?? "").slice(-40)}`).toLowerCase();

/** Transfer-log assertions for an open (sim_v2 `analyse_open`). */
export function analyseOpenLogs(logs: SimLog[], pool: Univ4AllowlistedPool, user: Address, depositIsToken0: boolean): OpenSimAnalysis {
  const t0 = pool.currency0.address.toLowerCase(), t1 = pool.currency1.address.toLowerCase();
  const [tokenIn, tokenOut] = depositIsToken0 ? [t0, t1] : [t1, t0];
  const pm = UNIV4_RHC.poolManager.toLowerCase(), posm = UNIV4_RHC.positionManager.toLowerCase();
  const fee = EVM_FEE_RECIPIENT.toLowerCase(), u = user.toLowerCase();
  let swapOutput = 0n, feePaid = 0n, feeOnDepositToken = 0n, refund0 = 0n, refund1 = 0n, nftTokenId: bigint | null = null;
  const nftTo: Address[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const token = log.address.toLowerCase(), from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]);
    if (log.topics.length === 4) {
      if (token === posm) { nftTo.push(to as Address); nftTokenId = BigInt(log.topics[3]!); }
      continue;
    }
    const [amount] = decodeAbiParameters([{ type: "uint256" }], log.data);
    if (token === tokenOut && from === pm) swapOutput += amount;
    if (to === fee) { feePaid += amount; if (token === tokenIn) feeOnDepositToken += amount; }
    if (from === posm && to === u) { if (token === t0) refund0 += amount; if (token === t1) refund1 += amount; }
  }
  const feeExpected = swapOutput * OPEN_FEE_BPS / 10_000n;
  return { swapOutput, feePaid, feeExpected, feeExact: feePaid === feeExpected, feeOnDepositToken, refund0, refund1, nftTo, nftTokenId,
    nftToUser: nftTo.length === 1 && nftTo[0] === u };
}
