import { parseAbi, parseAbiParameters } from "viem";

/** ABIs used by the open-position build/simulate path (PR2). Discovery ABIs stay in `abi.ts`. */
export const STATE_VIEW_TICKS_ABI = parseAbi([
  "function getTickBitmap(bytes32 poolId, int16 tick) view returns (uint256 tickBitmap)",
  "function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);

export const V4_QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  // Not `view` on chain (it reverts internally); called with eth_call only.
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

export const POSITION_MANAGER_ABI = parseAbi([
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
  "function nextTokenId() view returns (uint256)",
]);

export const PERMIT2_ABI = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export const ERC20_OPEN_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** keccak256("Transfer(address,address,uint256)") — ERC20 (2 indexed) and ERC721 (3 indexed) share it. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/** UR / POSM input encodings (v4-periphery, universal-router 2.1.x). */
export const UR_PARAMS = {
  permit2Permit: parseAbiParameters("((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature"),
  permit2TransferFrom: parseAbiParameters("address token, address recipient, uint160 amount"),
  sweep: parseAbiParameters("address token, address recipient, uint160 amountMin"),
  v4Swap: parseAbiParameters("bytes actions, bytes[] params"),
  posmUnlockData: parseAbiParameters("bytes actions, bytes[] params"),
  settle: parseAbiParameters("address currency, uint256 amount, bool payerIsUser"),
  take: parseAbiParameters("address currency, address recipient, uint256 amount"),
  takePortion: parseAbiParameters("address currency, address recipient, uint256 bips"),
  sweepCurrency: parseAbiParameters("address currency, address to"),
  exactInputSingle: parseAbiParameters("((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)"),
  mintPosition: parseAbiParameters("(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData"),
} as const;

/** Universal Router command bytes (Commands.sol). */
export const UR_COMMAND = Object.freeze({
  PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04,
  PERMIT2_PERMIT: 0x0a,
  V4_SWAP: 0x10,
  V4_POSITION_MANAGER_CALL: 0x14,
});

/** v4-periphery Actions.sol. MINT_POSITION_FROM_DELTAS (0x05) is deliberately absent: the checker bans it. */
export const V4_ACTION = Object.freeze({
  MINT_POSITION: 0x02,
  MINT_POSITION_FROM_DELTAS: 0x05,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  SWEEP: 0x14,
});

/** Revert selectors the open path recognises. */
export const KNOWN_REVERTS = Object.freeze({
  "0x31e30ad0": "MaximumAmountExceeded",
  "0x8b063d73": "V4TooLittleReceived",
  "0x7a5ed734": "NotEnoughLiquidity",
  "0x6190b2b0": "UnexpectedRevertBytes",
  "0x815e1d64": "InvalidSigner",
  "0xcd21db4f": "SignatureExpired",
  "0x756688fe": "InvalidNonce",
  "0xd81b2f2e": "AllowanceExpired",
  "0xf96fb071": "InsufficientAllowance",
  "0xbfb22adf": "DeadlinePassed",
  "0x5212cba1": "CurrencyNotSettled",
  "0x5bf6f916": "TransactionDeadlinePassed",
} as const);
export type KnownRevert = (typeof KNOWN_REVERTS)[keyof typeof KNOWN_REVERTS];
