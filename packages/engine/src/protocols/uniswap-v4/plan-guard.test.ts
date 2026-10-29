import { type Address, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, type Hex, hexToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { POSITION_MANAGER_ABI, UNIVERSAL_ROUTER_ABI, UR_COMMAND, UR_PARAMS, V4_ACTION } from "./open-abi";
import { PINNED_UNIVERSAL_ROUTER } from "./open-constants";
import type { OpenAmounts } from "./open-quote";
import { checkOpenPlan, type GuardInput, PlanGuardError } from "./plan-guard";
import { buildOpenExecute, buildPermitSingle } from "./tx-open-ur";

const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const user = "0xab9069703d7df7c4a472bc634312f087f0b9b320" as Address;
const attacker = "0x000000000000000000000000000000000000dEaD" as Address;
const NOW = 1_800_000_000;
const E18 = 10n ** 18n;
const SIG = `0x${"ab".repeat(65)}` as Hex;
/** Dummy fee recipient (never a real wallet; the real one is the server-only env RHC_UNIV4_FEE_WALLET). */
const FEE = getAddress("0x000000000000000000000000000000000000fee5");

const swapAmounts: OpenAmounts = {
  kind: "swap", zeroForOne: true, amountIn: 2n * E18, swapIn: 1_081_300_000_000_000_000n, quoteOut: 1_081_267_182_139_017_000n,
  minOut: 1_080_726_548_547_947_491n, fee: 1_081_267_182_139_017n, liquidity: 91_000_000_000_000_000_000n,
  amount0Max: 918_700_000_000_000_000n, amount1Max: 1_080_185_914_956_877_983n, priceTolBps: 0.2, slippageBps: 5n,
  sqrtPriceAfterX96: 0n, ticksCrossed: [], iterations: 3,
};
const noSwapAmounts: OpenAmounts = { ...swapAmounts, kind: "no-swap", swapIn: 0n, quoteOut: 0n, minOut: 0n, fee: 0n, amount1Max: 0n, amount0Max: 2n * E18 };

function build(amounts = swapAmounts, tickLower = -11, tickUpper = 9) {
  const permit = buildPermitSingle(pool.currency0.address, amounts.amountIn, 0, NOW);
  return buildOpenExecute({ pool, user, depositIsToken0: true, amounts, tickLower, tickUpper, permit, signature: SIG, nowSeconds: NOW, feeRecipient: FEE });
}
const guard = (tx: GuardInput["tx"], extra: Partial<GuardInput> = {}) =>
  checkOpenPlan({ tx, pool, user, tokenIn: pool.currency0.address, nowSeconds: NOW, routerCodeHash: PINNED_UNIVERSAL_ROUTER.runtimeCodeHash, feeRecipient: FEE, ...extra });
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof PlanGuardError) return e.code; throw e; } return "ok"; };

/** Editable view of an execute: UR commands/inputs, V4_SWAP actions/params, POSM actions/params. */
type Parts = { commands: number[]; inputs: Hex[]; deadline: bigint; swap?: { actions: number[]; params: Hex[] }; posm: { actions: number[]; params: Hex[]; deadline: bigint } };
function explode(data: Hex): Parts {
  const { args } = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
  const [cmds, inputs, deadline] = args as [Hex, Hex[], bigint];
  const commands = [...hexToBytes(cmds)];
  const si = commands.indexOf(UR_COMMAND.V4_SWAP);
  const swapDec = si >= 0 ? decodeAbiParameters(UR_PARAMS.v4Swap, inputs[si]!) : null;
  const pi = commands.indexOf(UR_COMMAND.V4_POSITION_MANAGER_CALL);
  const ml = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data: inputs[pi]! }).args as [Hex, bigint];
  const [pa, pp] = decodeAbiParameters(UR_PARAMS.posmUnlockData, ml[0]);
  return { commands, inputs: [...inputs], deadline,
    ...(swapDec ? { swap: { actions: [...hexToBytes(swapDec[0])], params: [...swapDec[1]] } } : {}),
    posm: { actions: [...hexToBytes(pa)], params: [...pp], deadline: ml[1] } };
}
function implode(p: Parts): Hex {
  const inputs = [...p.inputs];
  const si = p.commands.indexOf(UR_COMMAND.V4_SWAP);
  if (si >= 0 && p.swap) inputs[si] = encodeAbiParameters(UR_PARAMS.v4Swap, [toHex(Uint8Array.from(p.swap.actions)), p.swap.params]);
  const pi = p.commands.indexOf(UR_COMMAND.V4_POSITION_MANAGER_CALL);
  if (pi >= 0) inputs[pi] = encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "modifyLiquidities",
    args: [encodeAbiParameters(UR_PARAMS.posmUnlockData, [toHex(Uint8Array.from(p.posm.actions)), p.posm.params]), p.posm.deadline] });
  return encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: "execute", args: [toHex(Uint8Array.from(p.commands)), inputs, p.deadline] });
}
function mutate(fn: (p: Parts) => void, base = build()) {
  const p = explode(base.data);
  fn(p);
  return { ...base, data: implode(p) };
}
const mint = (p: Parts) => decodeAbiParameters(UR_PARAMS.mintPosition, p.posm.params[0]!);
const setMint = (p: Parts, patch: (m: ReturnType<typeof mint>) => unknown[]) => { p.posm.params[0] = encodeAbiParameters(UR_PARAMS.mintPosition, patch(mint(p)) as never); };

describe("checkOpenPlan accepts the builder's output", () => {
  it("swap (sequence A) and no-swap (sequence B), signed and pre-sign", () => {
    expect(guard(build())).toMatchObject({ sequence: "swap", tickLower: -11, tickUpper: 9, permitAmount: 2n * E18 });
    expect(guard(build(noSwapAmounts, 5, 30))).toMatchObject({ sequence: "no-swap", tickLower: 5, tickUpper: 30 });
    const permit = buildPermitSingle(pool.currency0.address, 2n * E18, 0, NOW);
    const pre = buildOpenExecute({ pool, user, depositIsToken0: true, amounts: swapAmounts, tickLower: -11, tickUpper: 9, permit, signature: null, nowSeconds: NOW, feeRecipient: FEE });
    expect(guard(pre, { presign: true })).toMatchObject({ sequence: "swap", permitAmount: null });
    expect(codeOf(() => guard(pre))).toBe("ur-sequence");
  });
});

describe("checkOpenPlan rejects unsafe plans", () => {
  it("unpinned router / codehash / wrong function", () => {
    expect(codeOf(() => guard({ ...build(), to: attacker }))).toBe("router-not-pinned");
    expect(codeOf(() => guard(build(), { routerCodeHash: `0x${"00".repeat(32)}` }))).toBe("router-codehash");
    expect(codeOf(() => guard({ ...build(), data: "0xdeadbeef" }))).toBe("not-execute");
  });
  it("msg.value on a token deposit", () => {
    expect(codeOf(() => guard({ ...build(), value: 1n }))).toBe("msg-value");
  });
  it("NFT owner other than the user", () => {
    expect(codeOf(() => guard(mutate(p => setMint(p, m => { const a = [...m]; a[6] = attacker; return a; }))))).toBe("nft-owner");
  });
  it("refund (POSM SWEEP) to anyone but the user", () => {
    expect(codeOf(() => guard(mutate(p => { p.posm.params[p.posm.params.length - 1] = encodeAbiParameters(UR_PARAMS.sweepCurrency, [pool.currency1.address, attacker]); })))).toBe("refund-recipient");
  });
  it("deprecated MINT_POSITION_FROM_DELTAS", () => {
    expect(codeOf(() => guard(mutate(p => { p.posm.actions[0] = V4_ACTION.MINT_POSITION_FROM_DELTAS; })))).toBe("deprecated-mint");
  });
  it("fee recipient, fee bps, fee on a no-swap plan", () => {
    const takePortionAt = (p: Parts) => p.swap!.actions.indexOf(V4_ACTION.TAKE_PORTION);
    expect(codeOf(() => guard(mutate(p => { p.swap!.params[takePortionAt(p)] = encodeAbiParameters(UR_PARAMS.takePortion, [pool.currency1.address, attacker, 10n]); })))).toBe("fee");
    expect(codeOf(() => guard(mutate(p => { p.swap!.params[takePortionAt(p)] = encodeAbiParameters(UR_PARAMS.takePortion, [pool.currency1.address, FEE, 11n]); })))).toBe("fee");
    // Fee on the deposit (input) token instead of the swap output.
    expect(codeOf(() => guard(mutate(p => { p.swap!.params[takePortionAt(p)] = encodeAbiParameters(UR_PARAMS.takePortion, [pool.currency0.address, FEE, 10n]); })))).not.toBe("ok");
    // A plan built for one fee wallet is rejected when the guard expects another (config drift).
    expect(codeOf(() => guard(build(), { feeRecipient: attacker }))).toBe("fee");
  });
  it("swap output taken to anyone but the POSM; leftover sweep to anyone but the POSM", () => {
    expect(codeOf(() => guard(mutate(p => { p.swap!.params[3] = encodeAbiParameters(UR_PARAMS.take, [pool.currency1.address, attacker, 0n]); })))).toBe("take-recipient");
    expect(codeOf(() => guard(mutate(p => { p.inputs[3] = encodeAbiParameters(UR_PARAMS.sweep, [pool.currency0.address, attacker, 0n]); })))).toBe("sweep-recipient");
  });
  it("transferFrom pulling more than the permit, or to a third party", () => {
    expect(codeOf(() => guard(mutate(p => { p.inputs[1] = encodeAbiParameters(UR_PARAMS.permit2TransferFrom, [pool.currency0.address, attacker, 2n * E18]); })))).toBe("transfer-recipient");
    expect(codeOf(() => guard(mutate(p => { p.inputs[1] = encodeAbiParameters(UR_PARAMS.permit2TransferFrom, [pool.currency0.address, "0x0000000000000000000000000000000000000002", 3n * E18]); })))).not.toBe("ok");
  });
  it("unexpected UR command sequence, POSM actions, or extra calls", () => {
    expect(codeOf(() => guard(mutate(p => { p.commands.push(UR_COMMAND.SWEEP); p.inputs.push(p.inputs[3]!); })))).toBe("ur-sequence");
    expect(codeOf(() => guard(mutate(p => { p.posm.actions.push(V4_ACTION.SWEEP); p.posm.params.push(p.posm.params.at(-1)!); })))).toBe("posm-actions");
    expect(codeOf(() => guard(mutate(p => { p.swap!.actions[3] = V4_ACTION.TAKE_ALL; })))).toBe("swap-actions");
  });
  it("wrong pool key", () => {
    expect(codeOf(() => guard(mutate(p => setMint(p, m => { const a = [...m]; a[0] = { ...(m[0] as Record<string, unknown>), hooks: attacker } as never; return a; }))))).toBe("pool-key");
  });
  it("range narrower than ±10 ticks (PM decision 2026-10-29)", () => {
    expect(codeOf(() => guard(mutate(p => setMint(p, m => { const a = [...m]; a[1] = -9; a[2] = 9; return a; }))))).toBe("range");
    expect(() => guard(mutate(p => setMint(p, m => { const a = [...m]; a[1] = -9; a[2] = 9; return a; })))).toThrow(/minimum is ±10 ticks/);
    expect(guard(mutate(p => setMint(p, m => { const a = [...m]; a[1] = -10; a[2] = 10; return a; })))).toMatchObject({ tickLower: -10, tickUpper: 10 });
  });
  it("deadline further out than 10 minutes", () => {
    expect(codeOf(() => guard(mutate(p => { p.deadline = BigInt(NOW + 3600); })))).toBe("deadline");
  });
  it("POSM call to a non-allowlisted function", () => {
    const p = explode(build().data);
    const inputs = [...p.inputs];
    inputs[p.commands.indexOf(UR_COMMAND.V4_POSITION_MANAGER_CALL)] = encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "nextTokenId" });
    const data = encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: "execute", args: [toHex(Uint8Array.from(p.commands)), inputs, p.deadline] });
    expect(codeOf(() => guard({ ...build(), data }))).toBe("posm-call");
  });
});
