import { type Address, encodeAbiParameters, encodeFunctionData, type Hex, toHex } from "viem";
import { UNIV4_RHC, type Univ4AllowlistedPool } from "./constants";
import { POSITION_MANAGER_ABI, UNIVERSAL_ROUTER_ABI, UR_COMMAND, UR_PARAMS, V4_ACTION } from "./open-abi";
import {
  EVM_FEE_RECIPIENT, EXECUTE_DEADLINE_SECONDS, OPEN_DELTA, OPEN_FEE_BPS, PERMIT_EXPIRATION_SECONDS, PERMIT_SIG_DEADLINE_SECONDS,
  PINNED_UNIVERSAL_ROUTER, UR_ADDRESS_THIS,
} from "./open-constants";
import type { OpenAmounts } from "./open-quote";

/**
 * Builds the single Universal Router `execute` for opening a SPCX/SPCXon position (design §3.5, sim_v2 `build_open`).
 * Unsigned only: the Permit2 signature comes from the user's wallet (PR5+). Nothing here signs or sends.
 */

export const RHC_CHAIN_ID = 4663;

export type PermitSingle = {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
};

/** Permit2 `PermitSingle`: exact amount, 30 min expiration, 10 min sigDeadline, spender = pinned UR. */
export function buildPermitSingle(token: Address, amount: bigint, nonce: number, nowSeconds: number): PermitSingle {
  return {
    details: { token, amount, expiration: nowSeconds + PERMIT_EXPIRATION_SECONDS, nonce },
    spender: PINNED_UNIVERSAL_ROUTER.address,
    sigDeadline: BigInt(nowSeconds + PERMIT_SIG_DEADLINE_SECONDS),
  };
}

/** EIP-712 typed data for `eth_signTypedData_v4` (viem `signTypedData` shape). */
export function permitTypedData(permit: PermitSingle) {
  return {
    domain: { name: "Permit2", chainId: RHC_CHAIN_ID, verifyingContract: UNIV4_RHC.permit2 as Address },
    types: {
      PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
      PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
    },
    primaryType: "PermitSingle" as const,
    message: permit,
  };
}

export type OpenTxRequest = { from: Address; to: Address; data: Hex; value: 0n };

export type BuildOpenArgs = {
  pool: Univ4AllowlistedPool;
  user: Address;
  depositIsToken0: boolean;
  amounts: OpenAmounts;
  tickLower: number;
  tickUpper: number;
  permit: PermitSingle;
  /**
   * The user's Permit2 signature. `null` builds the pre-sign simulation variant: no PERMIT2_PERMIT command;
   * the simulator grants the same allowance with an unsigned `Permit2.approve` call from the user instead.
   */
  signature: Hex | null;
  nowSeconds: number;
};

const poolKeyTuple = (pool: Univ4AllowlistedPool) => ({
  currency0: pool.currency0.address, currency1: pool.currency1.address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks,
});

export function buildOpenExecute(args: BuildOpenArgs): OpenTxRequest & { deadline: bigint } {
  const { pool, user, amounts: a, depositIsToken0: z } = args;
  const tokenIn = z ? pool.currency0.address : pool.currency1.address;
  const tokenOut = z ? pool.currency1.address : pool.currency0.address;
  const posm = UNIV4_RHC.positionManager as Address;
  const deadline = BigInt(args.nowSeconds + EXECUTE_DEADLINE_SECONDS);
  const commands: number[] = [], inputs: Hex[] = [];
  if (args.signature !== null) {
    commands.push(UR_COMMAND.PERMIT2_PERMIT);
    inputs.push(encodeAbiParameters(UR_PARAMS.permit2Permit, [args.permit, args.signature]));
  }
  if (a.kind === "swap") {
    commands.push(UR_COMMAND.PERMIT2_TRANSFER_FROM);
    inputs.push(encodeAbiParameters(UR_PARAMS.permit2TransferFrom, [tokenIn, UR_ADDRESS_THIS, a.amountIn]));
    const actions = [V4_ACTION.SETTLE, V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.TAKE_PORTION, V4_ACTION.TAKE];
    const params = [
      encodeAbiParameters(UR_PARAMS.settle, [tokenIn, a.swapIn, false]),
      encodeAbiParameters(UR_PARAMS.exactInputSingle, [{ poolKey: poolKeyTuple(pool), zeroForOne: z, amountIn: OPEN_DELTA, amountOutMinimum: a.minOut, minHopPriceX36: 0n, hookData: "0x" }]),
      encodeAbiParameters(UR_PARAMS.takePortion, [tokenOut, EVM_FEE_RECIPIENT, OPEN_FEE_BPS]),
      encodeAbiParameters(UR_PARAMS.take, [tokenOut, posm, OPEN_DELTA]),
    ];
    commands.push(UR_COMMAND.V4_SWAP);
    inputs.push(encodeAbiParameters(UR_PARAMS.v4Swap, [toHex(Uint8Array.from(actions)), params]));
    commands.push(UR_COMMAND.SWEEP);
    inputs.push(encodeAbiParameters(UR_PARAMS.sweep, [tokenIn, posm, 0n]));
  } else {
    commands.push(UR_COMMAND.PERMIT2_TRANSFER_FROM);
    inputs.push(encodeAbiParameters(UR_PARAMS.permit2TransferFrom, [tokenIn, posm, a.amountIn]));
  }
  const pmActions: number[] = [V4_ACTION.MINT_POSITION];
  const pmParams: Hex[] = [encodeAbiParameters(UR_PARAMS.mintPosition,
    [poolKeyTuple(pool), args.tickLower, args.tickUpper, a.liquidity, a.amount0Max, a.amount1Max, user, "0x"])];
  const settle = a.kind === "swap" ? [pool.currency0.address, pool.currency1.address] : [tokenIn];
  for (const currency of settle) {
    pmActions.push(V4_ACTION.SETTLE);
    pmParams.push(encodeAbiParameters(UR_PARAMS.settle, [currency, OPEN_DELTA, false]));
  }
  for (const currency of [pool.currency0.address, pool.currency1.address]) {
    pmActions.push(V4_ACTION.SWEEP);
    pmParams.push(encodeAbiParameters(UR_PARAMS.sweepCurrency, [currency, user]));
  }
  const unlock = encodeAbiParameters(UR_PARAMS.posmUnlockData, [toHex(Uint8Array.from(pmActions)), pmParams]);
  commands.push(UR_COMMAND.V4_POSITION_MANAGER_CALL);
  inputs.push(encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "modifyLiquidities", args: [unlock, deadline] }));
  const data = encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: "execute", args: [toHex(Uint8Array.from(commands)), inputs, deadline] });
  return { from: user, to: PINNED_UNIVERSAL_ROUTER.address, data, value: 0n, deadline };
}
