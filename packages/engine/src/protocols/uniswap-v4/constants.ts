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
 * Curated StablePairHook pools on Robinhood Chain (PM/LJ 2026-10-30: all 11 RH↔Ondo pairs; allowlist only,
 * no RPC event scan). SPCX first; the rest by Initialize block. Each feeConfig is the on-chain snapshot
 * reviewed at allowlist time; a later hook change auto-delists the pool.
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
    initBlock: 98_426_863n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0x4c71fa93d5a448afc030cfec54e1779ed1d2498c905569ee817eb5cadcbdc6fb",
    baseSymbol: "NVDA",
    currency0: Object.freeze({ address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", decimals: 18, issuer: "robinhood" }),
    currency1: Object.freeze({ address: "0xf1b95AE4E7700b962714702EA53784Dc8492a856", symbol: "NVDAon", decimals: 18, issuer: "ondo" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_425_782n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_190_976_768_489_425_548_641_385_522n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0xdb42a69b7c64037d22f5bf0fb2f406bcb1349aac536d9a5cfc034c6d7ffee56e",
    baseSymbol: "SPY",
    currency0: Object.freeze({ address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", symbol: "SPY", decimals: 18, issuer: "robinhood" }),
    currency1: Object.freeze({ address: "0x533C5571ae586985E1FDDFAa24304284d970C62a", symbol: "SPYon", decimals: 18, issuer: "ondo" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_427_466n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 78_923_248_258_200_923_920_179_133_163n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0xf3f6a9d8b0f3caadb5bcc5b81ea798900fc9337e197246c2a033100aa35822be",
    baseSymbol: "META",
    currency0: Object.freeze({ address: "0x7b5026cfcB4De0cF3d9a39FE2A541514b71437A2", symbol: "METAon", decimals: 18, issuer: "ondo" }),
    currency1: Object.freeze({ address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", symbol: "META", decimals: 18, issuer: "robinhood" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_427_707n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_318_598_240_440_955_793_886_769_439n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0x8e3d223e7f1a5c92f7bd21caf8accc55c0010dc0b70b8afda6d90976c56c666b",
    baseSymbol: "GOOGL",
    currency0: Object.freeze({ address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", symbol: "GOOGL", decimals: 18, issuer: "robinhood" }),
    currency1: Object.freeze({ address: "0xe10cc5f0cd0C90322ebEB33e7757B2c9090146DC", symbol: "GOOGLon", decimals: 18, issuer: "ondo" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_427_929n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_138_550_743_844_651_105_956_404_597n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0x67ba244f324e4f9f9b29e7e7cda4ceb4f071a7787779e16d994d65879933511e",
    baseSymbol: "AAPL",
    currency0: Object.freeze({ address: "0x9Bf86418CaF2b7a939603d6c24219a77Bf7F9b33", symbol: "AAPLon", decimals: 18, issuer: "ondo" }),
    currency1: Object.freeze({ address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", decimals: 18, issuer: "robinhood" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_428_157n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_339_336_853_583_961_295_632_419_353n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0xa15bb71d9e49fc4368034c9633a3a076dcc5bbc7645968fd5850e2f4390ad0ba",
    baseSymbol: "MSTR",
    currency0: Object.freeze({ address: "0x09dedC334fC47ab543e5D70C7FD9D2B1aea175bd", symbol: "MSTRon", decimals: 18, issuer: "ondo" }),
    currency1: Object.freeze({ address: "0xec262a75e413fAfD0dF80480274532C79D42da09", symbol: "MSTR", decimals: 18, issuer: "robinhood" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_428_376n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0xf5d814e2f031f9fe2d75a954c9287c210cceda47aa018cab717fa4852052cd65",
    baseSymbol: "CRCL",
    currency0: Object.freeze({ address: "0x369C4748E98C153e9B7aDeBc3E71e9e2a5f60Dc0", symbol: "CRCLon", decimals: 18, issuer: "ondo" }),
    currency1: Object.freeze({ address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", symbol: "CRCL", decimals: 18, issuer: "robinhood" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_428_671n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0x72a40fc68ed7fd97ec2210a38feba79ee72fb4292c70135b846d2e615b7d86e8",
    baseSymbol: "TSLA",
    currency0: Object.freeze({ address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", symbol: "TSLA", decimals: 18, issuer: "robinhood" }),
    currency1: Object.freeze({ address: "0xB197F36C25BA9b66960688882A4dC595C6b04309", symbol: "TSLAon", decimals: 18, issuer: "ondo" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_428_985n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0x062add5db5f564c8c6645f0136d0d71aa1e8ce671689a5eb96095321f25213ca",
    baseSymbol: "QQQ",
    currency0: Object.freeze({ address: "0x300fE8a40701cE81460503fB886f9eD81A3B5e14", symbol: "QQQon", decimals: 18, issuer: "ondo" }),
    currency1: Object.freeze({ address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", symbol: "QQQ", decimals: 18, issuer: "robinhood" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_429_274n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 79_361_916_319_072_991_407_591_792_726n }),
  }) as Univ4AllowlistedPool,
  Object.freeze({
    poolId: "0x65912fd5f40c3a4cabdc8690379e1233682cc1e1643feade90190366ca644af6",
    baseSymbol: "GME",
    currency0: Object.freeze({ address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", symbol: "GME", decimals: 18, issuer: "robinhood" }),
    currency1: Object.freeze({ address: "0xB094d0d3221D7F7a9F14b0f78C34CD38d7ACf6F2", symbol: "GMEon", decimals: 18, issuer: "ondo" }),
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 1,
    hooks: STABLE_PAIR_HOOK.proxy,
    initBlock: 98_429_519n,
    feeConfig: Object.freeze({ k: 16609443, optimalFeeE6: 50, targetMultiplier: 100, referenceSqrtPriceX96: 78_557_847_820_315_518_351_984_351_027n }),
  }) as Univ4AllowlistedPool,
]);

/**
 * Block-rate anchor (block 98,425,782 at 1793019101 = 2026-10-26 20:51:41 UTC+8). The chain makes
 * ~9.6 blocks/s; windows are converted to block ranges from the measured rate between this anchor and
 * the latest block, so no per-window timestamp lookups are needed.
 */
export const RHC_BLOCK_ANCHOR = Object.freeze({ number: 98_425_782n, timestamp: 1_793_019_101 });
