import { getAddress, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { ERC20_METADATA_ABI, FEE_CONFIG_UPDATED_EVENT, MODIFY_LIQUIDITY_EVENT, STABLE_PAIR_HOOK_ABI, STATE_VIEW_ABI, SWAP_EVENT, UPGRADED_EVENT } from "./abi";
import { estimateUniv4Apr, liquidityByRange, type RangeLiquidity, type SwapSample, type Univ4AprEstimate } from "./apr";
import { ERC1967_IMPLEMENTATION_SLOT, RHC_BLOCK_ANCHOR, STABLE_PAIR_HOOK, UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS, type StableFeeConfig, type Univ4AllowlistedPool } from "./constants";
import { getLogsChunked, type ChunkedLogsOptions } from "./logs";
import { addressFromSlot, decodeHookPermissions, hookPermissionBits, isSortedPair, poolIdOf, type PoolKey } from "./pool-key";

/**
 * Read-only Uniswap v4 discovery on Robinhood Chain. Nothing here builds, signs or broadcasts a
 * transaction. State comes from StateView + the StablePairHook (one multicall) and the hook's ERC1967
 * implementation slot; history (swaps, liquidity changes, hook config / upgrade events) from
 * PoolManager and hook logs.
 */

export type TokenMetadata = { address: Address; name: string; symbol: string; decimals: number };

export type RawPoolState = {
  blockNumber: bigint;
  blockTimestamp: number;
  slot0: { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number } | null;
  liquidity: bigint | null;
  dynamicFee: { zeroForOne: number; oneForZero: number } | null;
  feeConfig: StableFeeConfig | null;
  implementation: Address | null;
  token0: TokenMetadata | null;
  token1: TokenMetadata | null;
};

export type RawPoolHistory = {
  scannedFrom: bigint;
  scannedTo: bigint;
  /** Swaps still inside the longest APR window. */
  swaps: SwapSample[];
  /** Net liquidity per (tickLower, tickUpper) from every ModifyLiquidity since pool init. */
  ranges: RangeLiquidity[];
  feeConfigUpdates: bigint[];
  upgrades: { blockNumber: bigint; implementation: Address }[];
};

export const poolKeyOf = (spec: Univ4AllowlistedPool): PoolKey => ({
  currency0: spec.currency0.address, currency1: spec.currency1.address, fee: spec.fee, tickSpacing: spec.tickSpacing, hooks: spec.hooks,
});

const ok = <T>(entry: { status: "success"; result: unknown } | { status: "failure" }) => (entry.status === "success" ? entry.result as T : null);

/** Current pool state: 1 block header + 1 multicall + 1 storage read (all at `latest`). */
export async function readPoolState(client: PublicClient, spec: Univ4AllowlistedPool): Promise<RawPoolState> {
  const block = await client.getBlock({ blockTag: "latest" });
  const key = poolKeyOf(spec);
  const token = (address: Address) => [
    { address, abi: ERC20_METADATA_ABI, functionName: "name" },
    { address, abi: ERC20_METADATA_ABI, functionName: "symbol" },
    { address, abi: ERC20_METADATA_ABI, functionName: "decimals" },
  ] as const;
  const results = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: UNIV4_RHC.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [spec.poolId] },
      { address: UNIV4_RHC.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [spec.poolId] },
      { address: spec.hooks, abi: STABLE_PAIR_HOOK_ABI, functionName: "getFee", args: [key] },
      { address: spec.hooks, abi: STABLE_PAIR_HOOK_ABI, functionName: "feeConfig", args: [spec.poolId] },
      ...token(spec.currency0.address),
      ...token(spec.currency1.address),
    ],
  });
  const implementationWord = await client.getStorageAt({ address: spec.hooks, slot: ERC1967_IMPLEMENTATION_SLOT });
  const slot0 = ok<readonly [bigint, number, number, number]>(results[0]!);
  const fee = ok<readonly [number, number]>(results[2]!);
  const config = ok<readonly [number, number, number, bigint]>(results[3]!);
  const meta = (address: Address, offset: number): TokenMetadata | null => {
    const name = ok<string>(results[offset]!), symbol = ok<string>(results[offset + 1]!), decimals = ok<number>(results[offset + 2]!);
    return name === null || symbol === null || decimals === null ? null : { address: getAddress(address), name, symbol, decimals: Number(decimals) };
  };
  return {
    blockNumber: block.number,
    blockTimestamp: Number(block.timestamp),
    slot0: slot0 && { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), protocolFee: Number(slot0[2]), lpFee: Number(slot0[3]) },
    liquidity: ok<bigint>(results[1]!),
    dynamicFee: fee && { zeroForOne: Number(fee[0]), oneForZero: Number(fee[1]) },
    feeConfig: config && { k: Number(config[0]), optimalFeeE6: Number(config[1]), targetMultiplier: Number(config[2]), referenceSqrtPriceX96: config[3] },
    implementation: addressFromSlot(implementationWord),
    token0: meta(spec.currency0.address, 4),
    token1: meta(spec.currency1.address, 7),
  };
}

export type ReadPoolHistoryOptions = ChunkedLogsOptions & {
  toBlock: bigint;
  /** Oldest block whose swaps are kept (APR window start). */
  swapsFromBlock: bigint;
  /** Previous scan to extend incrementally (same pool). */
  previous?: RawPoolHistory | null;
};

/**
 * Pool history from logs, incrementally on top of `previous`. Four single-topic queries (the official
 * RPC limits OR-topic filters to 100k blocks): Swap and ModifyLiquidity for this pool on PoolManager,
 * FeeConfigUpdated for this pool and Upgraded on the hook.
 */
export async function readPoolHistory(client: PublicClient, spec: Univ4AllowlistedPool, options: ReadPoolHistoryOptions): Promise<RawPoolHistory> {
  const previous = options.previous && options.previous.scannedTo < options.toBlock ? options.previous : null;
  if (options.previous && !previous) return pruneSwaps(options.previous, options.swapsFromBlock);
  const from = previous ? previous.scannedTo + 1n : spec.initBlock;
  const hookFrom = previous ? previous.scannedTo + 1n : STABLE_PAIR_HOOK.deployBlock;
  const to = options.toBlock;
  const chunk = { maxSpan: options.maxSpan, minSpan: options.minSpan, maxRequests: options.maxRequests };
  const swapFrom = from > options.swapsFromBlock ? from : options.swapsFromBlock;
  const swaps = await getLogsChunked((fromBlock, toBlock) => client.getLogs({ address: UNIV4_RHC.poolManager, event: SWAP_EVENT, args: { id: spec.poolId }, fromBlock, toBlock, strict: true }), swapFrom, to, chunk);
  const modifications = await getLogsChunked((fromBlock, toBlock) => client.getLogs({ address: UNIV4_RHC.poolManager, event: MODIFY_LIQUIDITY_EVENT, args: { id: spec.poolId }, fromBlock, toBlock, strict: true }), from, to, chunk);
  const feeConfigUpdates = await getLogsChunked((fromBlock, toBlock) => client.getLogs({ address: spec.hooks, event: FEE_CONFIG_UPDATED_EVENT, args: { poolId: spec.poolId }, fromBlock, toBlock, strict: true }), hookFrom, to, chunk);
  const upgrades = await getLogsChunked((fromBlock, toBlock) => client.getLogs({ address: spec.hooks, event: UPGRADED_EVENT, fromBlock, toBlock, strict: true }), hookFrom, to, chunk);
  const next: RawPoolHistory = {
    scannedFrom: previous?.scannedFrom ?? spec.initBlock,
    scannedTo: to,
    swaps: [...(previous?.swaps ?? []), ...swaps.map(log => ({
      blockNumber: log.blockNumber!, amount0: log.args.amount0, amount1: log.args.amount1, liquidity: log.args.liquidity, tick: Number(log.args.tick), fee: Number(log.args.fee),
    }))],
    ranges: liquidityByRange([...(previous?.ranges ?? []).map(range => ({ tickLower: range.tickLower, tickUpper: range.tickUpper, liquidityDelta: range.liquidity })),
      ...modifications.map(log => ({ tickLower: Number(log.args.tickLower), tickUpper: Number(log.args.tickUpper), liquidityDelta: log.args.liquidityDelta }))]),
    feeConfigUpdates: [...(previous?.feeConfigUpdates ?? []), ...feeConfigUpdates.map(log => log.blockNumber!)],
    upgrades: [...(previous?.upgrades ?? []), ...upgrades.map(log => ({ blockNumber: log.blockNumber!, implementation: getAddress(log.args.implementation) }))],
  };
  return pruneSwaps(next, options.swapsFromBlock);
}

const pruneSwaps = (history: RawPoolHistory, fromBlock: bigint): RawPoolHistory =>
  ({ ...history, swaps: history.swaps.filter(swap => swap.blockNumber >= fromBlock) });

export type Univ4CheckId =
  | "pool-id" | "pool-key" | "initialized" | "hook-permissions" | "hook-implementation" | "fee-config"
  | "fee-config-events" | "upgrade-events" | "token-metadata";

/** `ok: null` = not checked this time (history unavailable); it never lists or delists on its own. */
export type Univ4Check = { id: Univ4CheckId; ok: boolean | null; detail: string };

export type Univ4PoolStatus = "listed" | "delisted";

export type Univ4PoolSummary = {
  protocol: "uniswap-v4-rhc";
  chainId: 4663;
  poolId: Hex;
  baseSymbol: string;
  /** Allowlisted and every state check passed. Read-only: nothing can be opened yet (PR1). */
  status: Univ4PoolStatus;
  delistReasons: Univ4CheckId[];
  checks: Univ4Check[];
  token0: TokenMetadata & { issuer: "robinhood" | "ondo" };
  token1: TokenMetadata & { issuer: "robinhood" | "ondo" };
  hooks: Address;
  hookImplementation: Address | null;
  hookPermissions: string[];
  tickSpacing: number;
  blockNumber: string;
  blockTimestamp: number;
  sqrtPriceX96: string | null;
  tick: number | null;
  /** token1 per token0 (decimal-adjusted). */
  price: number | null;
  liquidity: string | null;
  /** StablePairHook dynamic fee right now, pips (1e6 = 100%), per direction. */
  dynamicFeePips: { zeroForOne: number; oneForZero: number } | null;
  protocolFee: number | null;
  feeConfig: { k: number; optimalFeeE6: number; targetMultiplier: number; referenceSqrtPriceX96: string } | null;
  referencePrice: number | null;
  /** (price / referencePrice − 1) in bps. */
  priceVsReferenceBps: number | null;
  apr: Univ4AprEstimate | null;
  historyScannedTo: string | null;
  warnings: string[];
};

const sameConfig = (a: StableFeeConfig, b: StableFeeConfig) =>
  a.k === b.k && a.optimalFeeE6 === b.optimalFeeE6 && a.targetMultiplier === b.targetMultiplier && a.referenceSqrtPriceX96 === b.referenceSqrtPriceX96;

export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

/**
 * Apply the allowlist invariants (design §3.1 / §9 risk 1). Any failed state check auto-delists the
 * pool: wrong pool id / key, uninitialized, unexpected hook permissions, a hook implementation other
 * than the reviewed StablePairHook, a fee config that differs from the reviewed snapshot, unexpected
 * token metadata, or any FeeConfigUpdated / Upgraded event after the reviewed deployment.
 * Unreadable state counts as failed (fail closed).
 */
export function evaluatePool(spec: Univ4AllowlistedPool, state: RawPoolState, history: RawPoolHistory | null, now: { blocksPerSecond?: number } = {}): Univ4PoolSummary {
  const key = poolKeyOf(spec);
  const checks: Univ4Check[] = [];
  const add = (id: Univ4CheckId, okValue: boolean | null, detail: string) => checks.push({ id, ok: okValue, detail });

  const computedId = poolIdOf(key);
  add("pool-id", computedId === spec.poolId.toLowerCase(), computedId === spec.poolId.toLowerCase() ? "keccak256(PoolKey) matches" : `computed ${computedId}`);
  const keyOk = spec.fee === 0x800000 && spec.tickSpacing === 1 && isAddressEqual(spec.hooks, STABLE_PAIR_HOOK.proxy) && isSortedPair(spec.currency0.address, spec.currency1.address);
  add("pool-key", keyOk, keyOk ? "dynamic fee, tickSpacing 1, StablePairHook proxy, sorted currencies" : "unexpected PoolKey");
  add("initialized", state.slot0 ? state.slot0.sqrtPriceX96 > 0n : false, state.slot0 ? `tick ${state.slot0.tick}` : "slot0 unreadable");
  const bits = hookPermissionBits(spec.hooks);
  add("hook-permissions", bits === STABLE_PAIR_HOOK.permissions, `0x${bits.toString(16)}`);
  add("hook-implementation", state.implementation ? isAddressEqual(state.implementation, STABLE_PAIR_HOOK.implementation) : false,
    state.implementation ?? "implementation slot unreadable");
  add("fee-config", state.feeConfig ? sameConfig(state.feeConfig, spec.feeConfig) : false,
    state.feeConfig ? (sameConfig(state.feeConfig, spec.feeConfig) ? "matches reviewed config" : "differs from reviewed config") : "feeConfig unreadable");
  const metaOk = (meta: TokenMetadata | null, expected: { symbol: string; decimals: number }) => meta !== null && meta.decimals === expected.decimals && meta.symbol === expected.symbol;
  const tokensOk = metaOk(state.token0, spec.currency0) && metaOk(state.token1, spec.currency1);
  add("token-metadata", tokensOk, tokensOk ? `${spec.currency0.symbol}/${spec.currency1.symbol}, ${spec.currency0.decimals}/${spec.currency1.decimals} decimals` : "token symbol/decimals unreadable or changed");
  if (history) {
    add("fee-config-events", history.feeConfigUpdates.length === 0, history.feeConfigUpdates.length === 0 ? "no FeeConfigUpdated since hook deployment" : `FeeConfigUpdated at ${history.feeConfigUpdates.join(", ")}`);
    const unexpected = history.upgrades.filter(upgrade => !(upgrade.blockNumber === STABLE_PAIR_HOOK.deployBlock && isAddressEqual(upgrade.implementation, STABLE_PAIR_HOOK.implementation)));
    add("upgrade-events", unexpected.length === 0, unexpected.length === 0 ? "only the deployment upgrade" : `Upgraded at ${unexpected.map(upgrade => upgrade.blockNumber).join(", ")}`);
  } else {
    add("fee-config-events", null, "history unavailable");
    add("upgrade-events", null, "history unavailable");
  }

  const delistReasons = checks.filter(check => check.ok === false).map(check => check.id);
  const decimals0 = state.token0?.decimals ?? spec.currency0.decimals, decimals1 = state.token1?.decimals ?? spec.currency1.decimals;
  const price = state.slot0 && state.slot0.sqrtPriceX96 > 0n ? sqrtPriceX96ToPrice(state.slot0.sqrtPriceX96, decimals0, decimals1) : null;
  const referencePrice = state.feeConfig ? sqrtPriceX96ToPrice(state.feeConfig.referenceSqrtPriceX96, decimals0, decimals1) : null;
  const warnings: string[] = [];
  if (state.slot0 && state.slot0.protocolFee !== 0) warnings.push("protocol fee is non-zero: APR assumes LPs keep the full swap fee");
  let apr: Univ4AprEstimate | null = null;
  if (history && state.slot0 && state.slot0.sqrtPriceX96 > 0n) {
    const blocksPerSecond = now.blocksPerSecond ?? blocksPerSecondAt(state.blockNumber, state.blockTimestamp);
    apr = estimateUniv4Apr({
      swaps: history.swaps, ranges: history.ranges, sqrtPriceX96: state.slot0.sqrtPriceX96, tick: state.slot0.tick,
      toBlock: history.scannedTo, initBlock: spec.initBlock, blocksPerSecond, decimals0, decimals1,
    });
    if (state.liquidity !== null && apr.activeLiquidityFromRanges !== state.liquidity.toString())
      warnings.push("active liquidity from ModifyLiquidity history does not match StateView");
  }
  return {
    protocol: "uniswap-v4-rhc",
    chainId: 4663,
    poolId: spec.poolId,
    baseSymbol: spec.baseSymbol,
    status: delistReasons.length === 0 ? "listed" : "delisted",
    delistReasons,
    checks,
    token0: { ...(state.token0 ?? { address: spec.currency0.address, name: "", symbol: spec.currency0.symbol, decimals: spec.currency0.decimals }), issuer: spec.currency0.issuer },
    token1: { ...(state.token1 ?? { address: spec.currency1.address, name: "", symbol: spec.currency1.symbol, decimals: spec.currency1.decimals }), issuer: spec.currency1.issuer },
    hooks: getAddress(spec.hooks),
    hookImplementation: state.implementation,
    hookPermissions: decodeHookPermissions(spec.hooks),
    tickSpacing: spec.tickSpacing,
    blockNumber: state.blockNumber.toString(),
    blockTimestamp: state.blockTimestamp,
    sqrtPriceX96: state.slot0?.sqrtPriceX96.toString() ?? null,
    tick: state.slot0?.tick ?? null,
    price,
    liquidity: state.liquidity?.toString() ?? null,
    dynamicFeePips: state.dynamicFee,
    protocolFee: state.slot0?.protocolFee ?? null,
    feeConfig: state.feeConfig && { ...state.feeConfig, referenceSqrtPriceX96: state.feeConfig.referenceSqrtPriceX96.toString() },
    referencePrice,
    priceVsReferenceBps: price !== null && referencePrice ? (price / referencePrice - 1) * 10_000 : null,
    apr,
    historyScannedTo: history?.scannedTo.toString() ?? null,
    warnings,
  };
}

/** Measured block rate between the fixed anchor and `blockNumber`. */
export function blocksPerSecondAt(blockNumber: bigint, timestamp: number): number {
  const seconds = timestamp - RHC_BLOCK_ANCHOR.timestamp;
  return seconds > 0 && blockNumber > RHC_BLOCK_ANCHOR.number ? Number(blockNumber - RHC_BLOCK_ANCHOR.number) / seconds : 9.6;
}

export const APR_WINDOW_SECONDS = 7 * 86_400;

export type DiscoverUniv4Options = {
  clients: { state: PublicClient; logs: PublicClient };
  pools?: readonly Univ4AllowlistedPool[];
  /** Per-pool previous history (incremental log scans); updated in place by the caller. */
  history?: Map<Hex, RawPoolHistory>;
  logs?: ChunkedLogsOptions;
};

/**
 * One summary per allowlisted pool. A pool whose state cannot be read is reported delisted (fail
 * closed); history failures only drop APR and the event checks.
 */
export async function discoverUniv4RhcPools(options: DiscoverUniv4Options): Promise<Univ4PoolSummary[]> {
  const pools = options.pools ?? UNIV4_RHC_ALLOWLISTED_POOLS;
  const out: Univ4PoolSummary[] = [];
  for (const spec of pools) {
    let state: RawPoolState;
    try {
      state = await readPoolState(options.clients.state, spec);
    } catch {
      state = { blockNumber: 0n, blockTimestamp: 0, slot0: null, liquidity: null, dynamicFee: null, feeConfig: null, implementation: null, token0: null, token1: null };
      out.push(evaluatePool(spec, state, null));
      continue;
    }
    const blocksPerSecond = blocksPerSecondAt(state.blockNumber, state.blockTimestamp);
    const swapsFromBlock = state.blockNumber - BigInt(Math.ceil(APR_WINDOW_SECONDS * blocksPerSecond));
    let history: RawPoolHistory | null = null;
    try {
      history = await readPoolHistory(options.clients.logs, spec, {
        ...options.logs, toBlock: state.blockNumber, swapsFromBlock, previous: options.history?.get(spec.poolId) ?? null,
      });
      options.history?.set(spec.poolId, history);
    } catch {
      history = null;
    }
    out.push(evaluatePool(spec, state, history, { blocksPerSecond }));
  }
  return out;
}
