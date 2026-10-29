import type { Address, Hex } from "viem";

/**
 * Uniswap v4 on Robinhood Chain (4663). Addresses from developers.uniswap.org/docs/protocols/v4/deployments
 * and Uniswap/contracts deployments/4663.md; every one has code on chain (checked 2026-10-29).
 * Read-only discovery uses PoolManager (events), StateView (slot0 / liquidity) and the pool hook.
 */
export const UNIV4_RHC = Object.freeze({
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  universalRouter: "0x204FAca1764B154221e35c0d20aBb3c525710498",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, Address>);

/** v4 dynamic-fee flag (`LPFeeLibrary.DYNAMIC_FEE_FLAG`): the hook sets the fee per swap. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * Uniswap StablePairHook used by the Robinhood stock-token pairs: an ERC1967 (UUPS) proxy whose admin
 * is a single EOA (design §9 risk 1). Pools are auto-delisted if the implementation or a pool's fee
 * config differs from what was reviewed here.
 */
export const STABLE_PAIR_HOOK = Object.freeze({
  proxy: "0xd061f665d1c4816787FCeAa168FA66c59d3Abcc0",
  /** Official StablePairHook implementation (Uniswap/v4-hooks-public, Sourcify exact match). */
  implementation: "0xaF7895228C7E5ea4FA60d6CB7E42eedC99e94000",
  /** Proxy deployment block: the only `Upgraded` event is here, to `implementation`. */
  deployBlock: 98_423_592n,
  /**
   * Hook permission bits (low 14 bits of the address): before/afterInitialize, before/afterAddLiquidity,
   * before/afterSwap. No remove-liquidity, donate or return-delta permissions.
   */
  permissions: 0x3cc0,
  adminEoa: "0x9D9210Ea422bCFef44667d3DF14d01916154c0e4",
} as const);

/** EIP-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const ERC1967_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export type StableFeeConfig = {
  /** Per-block decay of the excess fee, Q24. */
  k: number;
  /** Optimal-range half width in price space and the fee inside it, pips (1e6 = 100%). */
  optimalFeeE6: number;
  targetMultiplier: number;
  referenceSqrtPriceX96: bigint;
};

export type RhcTokenSpec = { address: Address; symbol: string; decimals: number; issuer: "robinhood" | "ondo" };

export type Univ4AllowlistedPool = {
  /** keccak256(abi.encode(PoolKey)); recomputed and compared on every read. */
  poolId: Hex;
  /** Display: underlying stock. */
  baseSymbol: string;
  currency0: RhcTokenSpec;
  currency1: RhcTokenSpec;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  /** Block of the PoolManager `Initialize` event (start of event scans). */
  initBlock: bigint;
  /** Reviewed StablePairHook fee config; any difference auto-delists the pool. */
  feeConfig: StableFeeConfig;
};

/**
 * Curated pools. Discovery is allowlist-only and starts with SPCX/SPCXon (design §3.1). The other
 * ten RH↔Ondo pairs on the same hook are added one by one after SPCX passes real signing.
 */
export const UNIV4_RHC_ALLOWLISTED_POOLS: readonly Univ4AllowlistedPool[] = Object.freeze([
  Object.freeze({
    poolId: "0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c",
    baseSymbol: "SPCX",
    currency0: Object.freeze({ address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", symbol: "SPCX", decimals: 18, issuer: "robinhood" }),
    currency1: Object.freeze({ address: "0x9B8294F24453379aa87C807ab82bf1d5722153Fc", symbol: "SPCXon", decimals: 18, issuer: "ondo" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_425_782n,
    feeConfig: Object.freeze({ k: 16_609_443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n }),
  }) as Univ4AllowlistedPool,
]);

/**
 * Block-rate anchor (block 98,425,782 at 1793019101 = 2026-10-26 20:51:41 UTC+8). The chain makes
 * ~9.6 blocks/s; windows are converted to block ranges from the measured rate between this anchor and
 * the latest block, so no per-window timestamp lookups are needed.
 */
export const RHC_BLOCK_ANCHOR = Object.freeze({ number: 98_425_782n, timestamp: 1_793_019_101 });
