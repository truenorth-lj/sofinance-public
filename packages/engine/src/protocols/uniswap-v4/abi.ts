import { parseAbi, parseAbiItem } from "viem";

export const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const STABLE_PAIR_HOOK_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function getFee(PoolKey key) view returns (uint24 feeE6ZeroForOne, uint24 feeE6OneForZero)",
  "function feeConfig(bytes32 poolId) view returns (uint24 k, uint24 optimalFeeE6, uint8 targetMultiplier, uint160 referenceSqrtPriceX96)",
]);

export const ERC20_METADATA_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** PoolManager events (v4-core IPoolManager). */
export const SWAP_EVENT = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
export const MODIFY_LIQUIDITY_EVENT = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");

/** StablePairHook (IStableFeeConfiguration) and ERC1967 proxy events. */
export const FEE_CONFIG_UPDATED_EVENT = parseAbiItem("event FeeConfigUpdated(bytes32 indexed poolId, (uint24 k, uint24 optimalFeeE6, uint8 targetMultiplier, uint160 referenceSqrtPriceX96) feeConfig)");
export const UPGRADED_EVENT = parseAbiItem("event Upgraded(address indexed implementation)");
