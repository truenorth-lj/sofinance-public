import { type Address, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex, hexToBytes, isAddressEqual, toHex } from "viem";
import { UNIV4_RHC, type Univ4AllowlistedPool } from "./constants";
import { POSITION_MANAGER_ABI, UR_PARAMS, V4_ACTION } from "./open-abi";
import { EXECUTE_DEADLINE_SECONDS } from "./open-constants";

/**
 * Full exit of a Uniswap v4 position on Robinhood Chain (design §3.8 / §6.2, PR7): ONE direct
 * `PositionManager.modifyLiquidities` call from the owner (UR 0x14 forbids decrease/burn), value 0:
 *   DECREASE_LIQUIDITY(all, amount0Min, amount1Min) → BURN_POSITION → TAKE_PAIR(currency0, currency1, recipient = user).
 * Same order as Uniswap SDK `removeCallParameters` and the PR6 live exit. NO SoFinance fee on exit: there is no
 * TAKE_PORTION / fee step and no recipient other than the user. Unsigned only; nothing here signs or sends.
 */

export const EXIT_ACTIONS: readonly number[] = Object.freeze([V4_ACTION.DECREASE_LIQUIDITY, V4_ACTION.BURN_POSITION, V4_ACTION.TAKE_PAIR]);

export type ExitTxRequest = { from: Address; to: Address; data: Hex; value: 0n; deadline: bigint };

export type BuildExitArgs = {
  pool: Univ4AllowlistedPool;
  user: Address;
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  nowSeconds: number;
};

export function buildExitModifyLiquidities(args: BuildExitArgs): ExitTxRequest {
  const { pool, user, tokenId } = args;
  const deadline = BigInt(args.nowSeconds + EXECUTE_DEADLINE_SECONDS);
  const params: Hex[] = [
    encodeAbiParameters(UR_PARAMS.decreaseLiquidity, [tokenId, args.liquidity, args.amount0Min, args.amount1Min, "0x"]),
    encodeAbiParameters(UR_PARAMS.burnPosition, [tokenId, 0n, 0n, "0x"]),
    encodeAbiParameters(UR_PARAMS.takePair, [pool.currency0.address, pool.currency1.address, user]),
  ];
  const unlock = encodeAbiParameters(UR_PARAMS.posmUnlockData, [toHex(Uint8Array.from(EXIT_ACTIONS)), params]);
  const data = encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "modifyLiquidities", args: [unlock, deadline] });
  return { from: user, to: UNIV4_RHC.positionManager as Address, data, value: 0n, deadline };
}

export type ExitGuardCode = "posm-not-pinned" | "msg-value" | "sender" | "not-modify-liquidities" | "exit-actions" | "token-id" | "take-recipient" | "pool-key" | "deadline" | "fee";

export class ExitGuardError extends Error {
  constructor(readonly code: ExitGuardCode, message: string) {
    super(message);
    this.name = "ExitGuardError";
  }
}

const fail = (code: ExitGuardCode, message: string): never => { throw new ExitGuardError(code, message); };
const same = (a: string, b: string) => isAddressEqual(a as Address, b as Address);

export type ExitGuardInput = {
  tx: { from?: Address | string; to: Address | string; data: Hex | string; value?: bigint | string };
  pool: Univ4AllowlistedPool;
  user: Address | string;
  tokenId: bigint;
  /** When set, the deadline may not exceed now + EXECUTE_DEADLINE_SECONDS. */
  nowSeconds?: number;
  /** When set (server knows the EVM fee wallet), it must not appear anywhere in the exit. */
  feeRecipient?: Address | null;
};

export type ExitGuardResult = { liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint };

const isZeroValue = (v: bigint | string | undefined) => v === undefined || v === 0n || (typeof v === "string" && /^0x0*$/i.test(v));

/**
 * Independent checker for an exit transaction: decodes the calldata from scratch (it does not trust the builder) and
 * accepts only the reviewed shape. Pure (viem only), so the client runs it too right before `eth_sendTransaction`.
 */
export function checkExitPlan(input: ExitGuardInput): ExitGuardResult {
  const { tx, pool, user, tokenId } = input;
  if (!same(tx.to, UNIV4_RHC.positionManager)) fail("posm-not-pinned", `Exit must call the PositionManager ${UNIV4_RHC.positionManager}, not ${tx.to}`);
  if (!isZeroValue(tx.value)) fail("msg-value", "Exit must send 0 ETH");
  if (tx.from !== undefined && !same(tx.from, user)) fail("sender", "Exit sender must be the position owner");
  let call;
  try { call = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data: tx.data as Hex }); } catch { return fail("not-modify-liquidities", "Calldata is not PositionManager.modifyLiquidities"); }
  if (call.functionName !== "modifyLiquidities") fail("not-modify-liquidities", "Calldata is not PositionManager.modifyLiquidities");
  const [unlock, deadline] = call.args as readonly [Hex, bigint];
  if (input.nowSeconds !== undefined && deadline > BigInt(input.nowSeconds + EXECUTE_DEADLINE_SECONDS)) fail("deadline", "Exit deadline is longer than allowed");
  let actionsHex: Hex, params: readonly Hex[];
  try { [actionsHex, params] = decodeAbiParameters(UR_PARAMS.posmUnlockData, unlock); } catch { return fail("exit-actions", "Exit unlock data is malformed"); }
  const actions = [...hexToBytes(actionsHex)];
  if (actions.length !== EXIT_ACTIONS.length || actions.some((a, i) => a !== EXIT_ACTIONS[i]) || params.length !== actions.length)
    fail("exit-actions", `Exit actions must be [DECREASE_LIQUIDITY, BURN_POSITION, TAKE_PAIR], got [${actions.map(a => `0x${a.toString(16)}`).join(",")}]`);
  const [decId, liquidity, amount0Min, amount1Min] = decodeAbiParameters(UR_PARAMS.decreaseLiquidity, params[0]!);
  const [burnId] = decodeAbiParameters(UR_PARAMS.burnPosition, params[1]!);
  if (decId !== tokenId || burnId !== tokenId) fail("token-id", `Exit must decrease and burn position #${tokenId}`);
  const [c0, c1, recipient] = decodeAbiParameters(UR_PARAMS.takePair, params[2]!);
  if (!same(c0, pool.currency0.address) || !same(c1, pool.currency1.address)) fail("pool-key", "TAKE_PAIR currencies must be the allowlisted pool's tokens");
  if (input.feeRecipient && same(recipient, input.feeRecipient)) fail("fee", "No fee on exit: tokens may not go to the fee wallet");
  if (!same(recipient, user)) fail("take-recipient", "Exit tokens must go to the position owner");
  return { liquidity, amount0Min, amount1Min, deadline };
}
