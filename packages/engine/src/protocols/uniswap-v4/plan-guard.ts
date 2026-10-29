import { type Address, decodeAbiParameters, decodeFunctionData, type Hex, hexToBytes, isAddressEqual } from "viem";
import { UNIV4_RHC, type Univ4AllowlistedPool } from "./constants";
import { POSITION_MANAGER_ABI, UNIVERSAL_ROUTER_ABI, UR_COMMAND, UR_PARAMS, V4_ACTION } from "./open-abi";
import {
  EVM_FEE_RECIPIENT, EXECUTE_DEADLINE_SECONDS, OPEN_FEE_BPS, PERMIT_EXPIRATION_SECONDS, PERMIT_SIG_DEADLINE_SECONDS, PINNED_UNIVERSAL_ROUTER, UR_ADDRESS_THIS,
} from "./open-constants";
import { assertOpenRange, OpenPlanError } from "./open-quote";

/**
 * Independent checker for an open-position `execute` (design §6 test strategy, sim_v2 `plan_guard`). It decodes the
 * calldata from scratch — it does not trust the builder — and rejects anything outside the reviewed shapes.
 */

export type PlanGuardCode =
  | "router-not-pinned" | "router-codehash" | "msg-value" | "not-execute" | "ur-sequence" | "permit" | "transfer-recipient"
  | "swap-actions" | "fee" | "take-recipient" | "sweep-recipient" | "posm-call" | "deprecated-mint" | "posm-actions"
  | "pool-key" | "nft-owner" | "refund-recipient" | "range" | "deadline";

export class PlanGuardError extends Error {
  constructor(readonly code: PlanGuardCode, message: string) {
    super(message);
    this.name = "PlanGuardError";
  }
}

const fail = (code: PlanGuardCode, message: string): never => { throw new PlanGuardError(code, message); };

/** Allowed UR command sequences: A = swap + mint, B = mint only (range on the deposit side). */
export const ALLOWED_UR_SEQUENCES: readonly (readonly number[])[] = Object.freeze([
  [UR_COMMAND.PERMIT2_PERMIT, UR_COMMAND.PERMIT2_TRANSFER_FROM, UR_COMMAND.V4_SWAP, UR_COMMAND.SWEEP, UR_COMMAND.V4_POSITION_MANAGER_CALL],
  [UR_COMMAND.PERMIT2_PERMIT, UR_COMMAND.PERMIT2_TRANSFER_FROM, UR_COMMAND.V4_POSITION_MANAGER_CALL],
]);
export const ALLOWED_POSM_ACTIONS: readonly (readonly number[])[] = Object.freeze([
  [V4_ACTION.MINT_POSITION, V4_ACTION.SETTLE, V4_ACTION.SETTLE, V4_ACTION.SWEEP, V4_ACTION.SWEEP],
  [V4_ACTION.MINT_POSITION, V4_ACTION.SETTLE, V4_ACTION.SWEEP, V4_ACTION.SWEEP],
]);
const SWAP_ACTIONS = [V4_ACTION.SETTLE, V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.TAKE_PORTION, V4_ACTION.TAKE];
const DEPRECATED_MINTS: ReadonlySet<number> = new Set([V4_ACTION.MINT_POSITION_FROM_DELTAS]);

export type GuardInput = {
  tx: { from?: Address; to: Address; data: Hex; value?: bigint };
  pool: Univ4AllowlistedPool;
  user: Address;
  tokenIn: Address;
  nowSeconds: number;
  /** Pre-sign simulation variant: the leading PERMIT2_PERMIT is absent (allowance granted by Permit2.approve in the sim). */
  presign?: boolean;
  /** keccak256 of the router's runtime code at `latest`, when the caller has read it. */
  routerCodeHash?: Hex | null;
};

export type GuardResult = { sequence: "swap" | "no-swap"; tickLower: number; tickUpper: number; liquidity: bigint; permitAmount: bigint | null };

const same = (a: string, b: string) => isAddressEqual(a as Address, b as Address);
const bytesOf = (hex: Hex) => [...hexToBytes(hex)];
const eqSeq = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function checkOpenPlan(input: GuardInput): GuardResult {
  const { tx, pool, user, tokenIn } = input;
  const posm = UNIV4_RHC.positionManager as Address;
  if (!same(tx.to, PINNED_UNIVERSAL_ROUTER.address)) fail("router-not-pinned", `Router ${tx.to} is not the pinned Universal Router ${PINNED_UNIVERSAL_ROUTER.address}`);
  if (input.routerCodeHash !== undefined && input.routerCodeHash?.toLowerCase() !== PINNED_UNIVERSAL_ROUTER.runtimeCodeHash)
    fail("router-codehash", "Universal Router runtime code does not match the pinned 2.1.2 codehash");
  if ((tx.value ?? 0n) !== 0n) fail("msg-value", "msg.value must be 0 for token deposits");
  if (tx.from && !same(tx.from, user)) fail("permit", "Transaction sender must be the user");
  let decoded;
  try { decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data }); } catch { return fail("not-execute", "Calldata is not UR execute(bytes,bytes[],uint256)"); }
  const [commandsHex, inputs, deadline] = decoded.args;
  if (deadline > BigInt(input.nowSeconds + EXECUTE_DEADLINE_SECONDS)) fail("deadline", "Execute deadline is longer than allowed");
  const commands = bytesOf(commandsHex);
  const allowed = ALLOWED_UR_SEQUENCES.map(seq => (input.presign ? seq.slice(1) : seq));
  if (!allowed.some(seq => eqSeq(seq, commands))) fail("ur-sequence", `UR command sequence not allowed: [${commands.map(c => `0x${c.toString(16)}`).join(",")}]`);
  if (inputs.length !== commands.length) fail("ur-sequence", "commands/inputs length mismatch");
  const tokenOut = same(tokenIn, pool.currency0.address) ? pool.currency1.address : pool.currency0.address;
  if (!same(tokenIn, pool.currency0.address) && !same(tokenIn, pool.currency1.address)) fail("permit", "Deposit token is not in the pool");
  let feeSeen = 0, permitAmount: bigint | null = null, transferAmount = 0n;
  let result: Omit<GuardResult, "permitAmount"> | null = null;
  commands.forEach((command, i) => {
    const data = inputs[i]!;
    if (command === UR_COMMAND.PERMIT2_PERMIT) {
      const [permit] = decodeAbiParameters(UR_PARAMS.permit2Permit, data);
      if (!same(permit.spender, PINNED_UNIVERSAL_ROUTER.address)) fail("permit", "Permit spender must be the pinned Universal Router");
      if (!same(permit.details.token, tokenIn)) fail("permit", "Permit token must be the deposit token");
      if (permit.details.amount <= 0n) fail("permit", "Permit amount must be set");
      if (permit.details.expiration > input.nowSeconds + PERMIT_EXPIRATION_SECONDS || permit.details.expiration <= input.nowSeconds) fail("permit", "Permit expiration must be within 30 minutes");
      if (permit.sigDeadline > BigInt(input.nowSeconds + PERMIT_SIG_DEADLINE_SECONDS)) fail("permit", "Permit sigDeadline must be within 10 minutes");
      permitAmount = permit.details.amount;
    } else if (command === UR_COMMAND.PERMIT2_TRANSFER_FROM) {
      const [token, recipient, amount] = decodeAbiParameters(UR_PARAMS.permit2TransferFrom, data);
      if (!same(token, tokenIn)) fail("transfer-recipient", "transferFrom token must be the deposit token");
      if (same(recipient, EVM_FEE_RECIPIENT)) fail("transfer-recipient", "No direct transfer to the fee recipient");
      const expected = commands.includes(UR_COMMAND.V4_SWAP) ? UR_ADDRESS_THIS : posm;
      if (!same(recipient, expected)) fail("transfer-recipient", `transferFrom recipient must be ${expected}`);
      transferAmount = amount;
    } else if (command === UR_COMMAND.V4_SWAP) {
      const [actionsHex, params] = decodeAbiParameters(UR_PARAMS.v4Swap, data);
      const actions = bytesOf(actionsHex);
      if (!eqSeq(actions, SWAP_ACTIONS) || params.length !== 4) fail("swap-actions", `V4_SWAP actions not allowed: [${actions.join(",")}]`);
      const [settleCurrency, , payerIsUser] = decodeAbiParameters(UR_PARAMS.settle, params[0]!);
      if (!same(settleCurrency, tokenIn) || payerIsUser) fail("swap-actions", "Swap must settle the deposit token from the router");
      const [swap] = decodeAbiParameters(UR_PARAMS.exactInputSingle, params[1]!);
      checkPoolKey(swap.poolKey, pool);
      if (swap.zeroForOne !== same(tokenIn, pool.currency0.address)) fail("swap-actions", "Swap direction must sell the deposit token");
      if (swap.amountOutMinimum <= 0n) fail("swap-actions", "Swap must set amountOutMinimum");
      const [feeCurrency, feeRecipient, bips] = decodeAbiParameters(UR_PARAMS.takePortion, params[2]!);
      if (!same(feeRecipient, EVM_FEE_RECIPIENT) || bips !== OPEN_FEE_BPS || !same(feeCurrency, tokenOut))
        fail("fee", "Fee must be TAKE_PORTION(swap output token, fee recipient, 10 bps)");
      feeSeen++;
      const [, takeRecipient] = decodeAbiParameters(UR_PARAMS.take, params[3]!);
      if (!same(takeRecipient, posm)) fail("take-recipient", "Swap output must go to the PositionManager");
    } else if (command === UR_COMMAND.SWEEP) {
      const [, recipient] = decodeAbiParameters(UR_PARAMS.sweep, data);
      if (!same(recipient, posm)) fail("sweep-recipient", "Router sweep must go to the PositionManager");
    } else if (command === UR_COMMAND.V4_POSITION_MANAGER_CALL) {
      let call;
      try { call = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data }); } catch { return fail("posm-call", "POSM call must be modifyLiquidities"); }
      if (call.functionName !== "modifyLiquidities") fail("posm-call", "POSM call must be modifyLiquidities");
      const [unlock] = call.args as readonly [Hex, bigint];
      const [actionsHex, params] = decodeAbiParameters(UR_PARAMS.posmUnlockData, unlock);
      const actions = bytesOf(actionsHex);
      if (actions.some(a => DEPRECATED_MINTS.has(a))) fail("deprecated-mint", "MINT_POSITION_FROM_DELTAS is not allowed; use MINT_POSITION");
      if (!ALLOWED_POSM_ACTIONS.some(seq => eqSeq(seq, actions)) || params.length !== actions.length) fail("posm-actions", `POSM actions not allowed: [${actions.join(",")}]`);
      const mint = decodeAbiParameters(UR_PARAMS.mintPosition, params[0]!);
      checkPoolKey(mint[0], pool);
      try { assertOpenRange(mint[1], mint[2], pool.tickSpacing); } catch (error) { fail("range", error instanceof OpenPlanError ? error.message : "Invalid range"); }
      if (!same(mint[6], user)) fail("nft-owner", "Position NFT owner must be the user");
      for (const p of params.slice(1, actions.length - 2)) {
        const [, , payer] = decodeAbiParameters(UR_PARAMS.settle, p);
        if (payer) fail("posm-actions", "POSM settle must pay from the PositionManager balance");
      }
      for (const p of params.slice(-2)) {
        const [, to] = decodeAbiParameters(UR_PARAMS.sweepCurrency, p);
        if (!same(to, user)) fail("refund-recipient", "Refund (SWEEP) recipient must be the user");
      }
      result = { sequence: commands.includes(UR_COMMAND.V4_SWAP) ? "swap" : "no-swap", tickLower: mint[1], tickUpper: mint[2], liquidity: mint[3] };
    }
  });
  if (feeSeen !== (commands.includes(UR_COMMAND.V4_SWAP) ? 1 : 0)) fail("fee", "Fee must be taken exactly once, only on a swap");
  if (permitAmount !== null && transferAmount > permitAmount) fail("permit", "transferFrom exceeds the permit amount");
  if (!result) return fail("posm-call", "Missing POSM call");
  return { ...(result as Omit<GuardResult, "permitAmount">), permitAmount };
}

function checkPoolKey(key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, pool: Univ4AllowlistedPool): void {
  if (!same(key.currency0, pool.currency0.address) || !same(key.currency1, pool.currency1.address) || key.fee !== pool.fee
    || key.tickSpacing !== pool.tickSpacing || !same(key.hooks, pool.hooks)) fail("pool-key", "Pool key does not match the allowlisted pool");
}
