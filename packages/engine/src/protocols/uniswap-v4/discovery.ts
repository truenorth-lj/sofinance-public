import { getAddress, isAddressEqual, type Address, type ContractFunctionParameters, type Hex, type PublicClient } from "viem";
import { ERC20_METADATA_ABI, STABLE_PAIR_HOOK_ABI, STATE_VIEW_ABI, TOKEN_CONTROLS_ABI } from "./abi";
import {
  ERC1967_IMPLEMENTATION_SLOT, STABLE_PAIR_HOOK, UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS, rhcTokenControls,
  type RhcTokenPower, type StableFeeConfig, type Univ4AllowlistedPool,
} from "./constants";
import { poolAprFromMarket, type Univ4MarketData, type Univ4PoolApr } from "./market-data";
import { addressFromSlot, decodeHookPermissions, hookPermissionBits, isSortedPair, poolIdOf, type PoolKey } from "./pool-key";

/**
 * Read-only Uniswap v4 discovery on Robinhood Chain. Nothing here builds, signs or broadcasts a
 * transaction. State comes from StateView + the StablePairHook (one multicall) and the hook's ERC1967
 * implementation slot; the same multicall reads each token's transfer controls (beacon implementation, paused).
 * No event scans (PM decision 2026-10-29): 24h volume / TVL come from public indexers
 * (`market-data.ts`) and RPC is used for current state only.
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
  /** Live transfer-control state per token (same multicall); absent in older captures = unread. */
  tokenControls?: [TokenControlState, TokenControlState];
};

/** `null` = unread (call failed or no reviewed controls for this token). */
export type TokenControlState = { implementation: Address | null; paused: boolean | null; pauseManager: Address | null };

export const poolKeyOf = (spec: Univ4AllowlistedPool): PoolKey => ({
  currency0: spec.currency0.address, currency1: spec.currency1.address, fee: spec.fee, tickSpacing: spec.tickSpacing, hooks: spec.hooks,
});

const ok = <T>(entry: { status: "success"; result: unknown } | { status: "failure" }) => (entry.status === "success" ? entry.result as T : null);

type ControlCall = { address: Address; abi: typeof TOKEN_CONTROLS_ABI; functionName: "implementation" | "paused" | "tokenPauseManager" | "isTokenPaused"; args?: readonly [Address] };

/** Calls that read one token's transfer controls; `read` turns their results (in order) into a `TokenControlState`. */
function tokenControlCalls(token: Address): { calls: ControlCall[]; read: (results: readonly unknown[]) => TokenControlState } {
  const controls = rhcTokenControls(token);
  if (!controls) return { calls: [], read: () => ({ implementation: null, paused: null, pauseManager: null }) };
  const calls: ControlCall[] = [{ address: controls.beacon, abi: TOKEN_CONTROLS_ABI, functionName: "implementation" }];
  if (controls.pause.kind === "self") {
    calls.push({ address: controls.token, abi: TOKEN_CONTROLS_ABI, functionName: "paused" });
    for (const target of controls.pause.extraTargets) calls.push({ address: target, abi: TOKEN_CONTROLS_ABI, functionName: "paused" });
  } else {
    calls.push({ address: controls.token, abi: TOKEN_CONTROLS_ABI, functionName: "tokenPauseManager" });
    calls.push({ address: controls.pause.manager, abi: TOKEN_CONTROLS_ABI, functionName: "isTokenPaused", args: [controls.token] });
  }
  return {
    calls,
    read: (results) => {
      const implementation = typeof results[0] === "string" ? getAddress(results[0]) : null;
      const flags = controls.pause.kind === "self" ? results.slice(1) : results.slice(2);
      const paused = flags.every(flag => typeof flag === "boolean") ? flags.some(Boolean) : flags.some(flag => flag === true) ? true : null;
      const pauseManager = controls.pause.kind === "manager" && typeof results[1] === "string" ? getAddress(results[1]) : null;
      return { implementation, paused, pauseManager };
    },
  };
}

/**
 * Current pool state: 1 block header + 1 multicall + 1 storage read (all at `latest`). `tokenControls: false` skips the
 * token transfer-control reads (the transaction-time re-read only needs the listing checks).
 */
export async function readPoolState(client: PublicClient, spec: Univ4AllowlistedPool, options: { tokenControls?: boolean } = {}): Promise<RawPoolState> {
  const withControls = options.tokenControls ?? true;
  const block = await client.getBlock({ blockTag: "latest" });
  const key = poolKeyOf(spec);
  const token = (address: Address) => [
    { address, abi: ERC20_METADATA_ABI, functionName: "name" },
    { address, abi: ERC20_METADATA_ABI, functionName: "symbol" },
    { address, abi: ERC20_METADATA_ABI, functionName: "decimals" },
  ] as const;
  const none = { calls: [] as ControlCall[], read: () => null };
  const controls0 = withControls ? tokenControlCalls(spec.currency0.address) : none;
  const controls1 = withControls ? tokenControlCalls(spec.currency1.address) : none;
  const results = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: UNIV4_RHC.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [spec.poolId] },
      { address: UNIV4_RHC.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [spec.poolId] },
      { address: spec.hooks, abi: STABLE_PAIR_HOOK_ABI, functionName: "getFee", args: [key] },
      { address: spec.hooks, abi: STABLE_PAIR_HOOK_ABI, functionName: "feeConfig", args: [spec.poolId] },
      ...token(spec.currency0.address),
      ...token(spec.currency1.address),
      ...controls0.calls,
      ...controls1.calls,
    ] as readonly ContractFunctionParameters[],
  });
  const controlResults = (from: number, count: number) => results.slice(from, from + count).map(entry => ok<unknown>(entry));
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
    ...(withControls ? { tokenControls: [
      controls0.read(controlResults(10, controls0.calls.length))!,
      controls1.read(controlResults(10 + controls0.calls.length, controls1.calls.length))!,
    ] as [TokenControlState, TokenControlState] } : {}),
  };
}

/** Issuer transfer controls of one token, as shown to users (docs/rhc-token-permissions.md). */
export type Univ4TokenControlsSummary = {
  symbol: string;
  address: Address;
  contract: string | null;
  /** Reviewed powers; any of them is shown like a Solana freeze authority. */
  powers: RhcTokenPower[];
  /** Live implementation / pause manager equal the reviewed ones; false when changed or unreadable. */
  reviewed: boolean;
  implementation: Address | null;
  /** Transfers paused right now; null when unread. */
  paused: boolean | null;
};

export type Univ4CheckId =
  | "pool-id" | "pool-key" | "initialized" | "hook-permissions" | "hook-implementation" | "fee-config" | "token-metadata";

/** `ok: null` = not checked this time; it never lists or delists on its own. */
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
  /** fee rate × 24h volume / TVL from DexScreener (GeckoTerminal fallback); null when neither has the pool. */
  /** Labelled 「估計」/"Estimated" wherever shown. */
  estimatedApr: Univ4PoolApr | null;
  /** Issuer transfer controls per token (pause / blocklist / admin burn / upgrade), from the multicall. */
  tokenControls: Univ4TokenControlsSummary[];
  /**
   * Some token's issuer can stop or block transfers (or its controls could not be confirmed): the same "Freeze risk"
   * flag a Solana mint with a freeze authority gets.
   */
  freezeRisk: boolean;
  warnings: string[];
};

function summarizeControls(token: Univ4AllowlistedPool["currency0"], live: TokenControlState | undefined): Univ4TokenControlsSummary {
  const controls = rhcTokenControls(token.address);
  if (!controls) return { symbol: token.symbol, address: getAddress(token.address), contract: null, powers: [], reviewed: false, implementation: null, paused: null };
  const implOk = live?.implementation ? isAddressEqual(live.implementation, controls.implementation) : false;
  const managerOk = controls.pause.kind === "manager" ? (live?.pauseManager ? isAddressEqual(live.pauseManager, controls.pause.manager) : false) : true;
  return {
    symbol: token.symbol, address: getAddress(controls.token), contract: controls.contract, powers: [...controls.powers],
    reviewed: implOk && managerOk, implementation: live?.implementation ?? null, paused: live?.paused ?? null,
  };
}

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
 * token metadata. Hook upgrades and fee-config changes are caught from current state (ERC1967 implementation
 * slot, `feeConfig(poolId)`) on every refresh, and re-read at transaction time. Unreadable state counts as
 * failed (fail closed).
 */
export function evaluatePool(spec: Univ4AllowlistedPool, state: RawPoolState, market: Univ4MarketData | null = null): Univ4PoolSummary {
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
  const delistReasons = checks.filter(check => check.ok === false).map(check => check.id);
  const decimals0 = state.token0?.decimals ?? spec.currency0.decimals, decimals1 = state.token1?.decimals ?? spec.currency1.decimals;
  const price = state.slot0 && state.slot0.sqrtPriceX96 > 0n ? sqrtPriceX96ToPrice(state.slot0.sqrtPriceX96, decimals0, decimals1) : null;
  const referencePrice = state.feeConfig ? sqrtPriceX96ToPrice(state.feeConfig.referenceSqrtPriceX96, decimals0, decimals1) : null;
  const warnings: string[] = [];
  if (state.slot0 && state.slot0.protocolFee !== 0) warnings.push("protocol fee is non-zero: APR assumes LPs keep the full swap fee");
  const estimatedApr = market && state.dynamicFee ? poolAprFromMarket(market, state.dynamicFee) : null;
  const tokenControls = [summarizeControls(spec.currency0, state.tokenControls?.[0]), summarizeControls(spec.currency1, state.tokenControls?.[1])];
  // Not read (transaction-time path) → no control warnings; the reviewed powers still count as a freeze risk.
  if (state.tokenControls) for (const controls of tokenControls) {
    if (controls.paused === true) warnings.push(`${controls.symbol} transfers are paused by its issuer right now`);
    if (controls.contract && !controls.reviewed) warnings.push(`${controls.symbol} token contract could not be confirmed as the reviewed version`);
  }
  // Fail closed: unknown or unconfirmed controls count as a freeze risk too.
  const freezeRisk = tokenControls.some(controls => controls.powers.length > 0 || (state.tokenControls !== undefined && !controls.reviewed));
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
    estimatedApr,
    tokenControls,
    freezeRisk,
    warnings,
  };
}

export type DiscoverUniv4Options = {
  clients: { state: PublicClient };
  pools?: readonly Univ4AllowlistedPool[];
  /** 24h volume / TVL per pool (host-cached public indexers); omitted or failing → `estimatedApr: null`. */
  marketData?: (spec: Univ4AllowlistedPool) => Promise<Univ4MarketData | null>;
};

/**
 * One summary per allowlisted pool. A pool whose state cannot be read is reported delisted (fail
 * closed); market-data failures only drop APR.
 */
export async function discoverUniv4RhcPools(options: DiscoverUniv4Options): Promise<Univ4PoolSummary[]> {
  const pools = options.pools ?? UNIV4_RHC_ALLOWLISTED_POOLS;
  const out: Univ4PoolSummary[] = [];
  for (const spec of pools) {
    const [state, market] = await Promise.all([
      readPoolState(options.clients.state, spec).catch((): RawPoolState => ({
        blockNumber: 0n, blockTimestamp: 0, slot0: null, liquidity: null, dynamicFee: null, feeConfig: null, implementation: null, token0: null, token1: null,
      })),
      options.marketData ? options.marketData(spec).catch(() => null) : Promise.resolve(null),
    ]);
    out.push(evaluatePool(spec, state, market));
  }
  return out;
}
