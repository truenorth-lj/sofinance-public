import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex, hexToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { POSITION_MANAGER_ABI, UR_PARAMS } from "./open-abi";
import { buildExitModifyLiquidities, checkExitPlan, EXIT_ACTIONS, ExitGuardError } from "./tx-exit-posm";

const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const USER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04" as const;
const FEE = "0x1111111111111111111111111111111111111111" as const;
const NOW = 1_800_000_000;
const tokenId = 4077059n;
const build = (over: Partial<Parameters<typeof buildExitModifyLiquidities>[0]> = {}) =>
  buildExitModifyLiquidities({ pool, user: USER, tokenId, liquidity: 29_340_323_272_345_554_694n, amount0Min: 13149176925997666n, amount1Min: 16035615754754612n, nowSeconds: NOW, ...over });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ExitGuardError ? e.code : `other:${String(e)}`; } return "ok"; };

/** Hand-encode modifyLiquidities with arbitrary actions/params (to forge bad exits). */
const forge = (actions: number[], params: Hex[], deadline = BigInt(NOW + 600)) =>
  encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "modifyLiquidities", args: [encodeAbiParameters(UR_PARAMS.posmUnlockData, [toHex(Uint8Array.from(actions)), params]), deadline] });
const dec = (id = tokenId) => encodeAbiParameters(UR_PARAMS.decreaseLiquidity, [id, 1n, 0n, 0n, "0x"]);
const burn = (id = tokenId) => encodeAbiParameters(UR_PARAMS.burnPosition, [id, 0n, 0n, "0x"]);
const take = (to: Hex = USER, c0: Hex = pool.currency0.address, c1: Hex = pool.currency1.address) => encodeAbiParameters(UR_PARAMS.takePair, [c0, c1, to]);

describe("buildExitModifyLiquidities", () => {
  it("is one value-0 PositionManager.modifyLiquidities: DECREASE_LIQUIDITY(all) → BURN → TAKE_PAIR to the owner", () => {
    const tx = build();
    expect(tx.to).toBe(UNIV4_RHC.positionManager);
    expect(tx.value).toBe(0n);
    expect(tx.from).toBe(USER);
    expect(tx.deadline).toBe(BigInt(NOW + 600));
    const call = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data: tx.data });
    expect(call.functionName).toBe("modifyLiquidities");
    const [unlock, deadline] = call.args as [Hex, bigint];
    expect(deadline).toBe(tx.deadline);
    const [actions, params] = decodeAbiParameters(UR_PARAMS.posmUnlockData, unlock);
    expect([...hexToBytes(actions)]).toEqual([0x01, 0x03, 0x11]);
    expect(EXIT_ACTIONS).toEqual([0x01, 0x03, 0x11]);
    expect(decodeAbiParameters(UR_PARAMS.decreaseLiquidity, params[0]!)).toEqual([tokenId, 29_340_323_272_345_554_694n, 13149176925997666n, 16035615754754612n, "0x"]);
    expect(decodeAbiParameters(UR_PARAMS.burnPosition, params[1]!)).toEqual([tokenId, 0n, 0n, "0x"]);
    const [c0, c1, to] = decodeAbiParameters(UR_PARAMS.takePair, params[2]!);
    expect([c0.toLowerCase(), c1.toLowerCase(), to.toLowerCase()]).toEqual([pool.currency0.address.toLowerCase(), pool.currency1.address.toLowerCase(), USER]);
  });
});

describe("checkExitPlan", () => {
  const tx = build();
  it("accepts the built exit and returns its mins", () => {
    expect(checkExitPlan({ tx, pool, user: USER, tokenId, nowSeconds: NOW, feeRecipient: FEE })).toEqual({
      liquidity: 29_340_323_272_345_554_694n, amount0Min: 13149176925997666n, amount1Min: 16035615754754612n, deadline: BigInt(NOW + 600),
    });
  });
  it.each([
    ["to is not the PositionManager", { tx: { ...tx, to: UNIV4_RHC.universalRouter } }, "posm-not-pinned"],
    ["value is not 0", { tx: { ...tx, value: 1n } }, "msg-value"],
    ["value hex is not 0", { tx: { ...tx, value: "0x1" } }, "msg-value"],
    ["sender is another wallet", { tx: { ...tx, from: FEE } }, "sender"],
    ["calldata is not modifyLiquidities", { tx: { ...tx, data: "0x12345678" } }, "not-modify-liquidities"],
    ["the token id differs", { tokenId: 1n }, "token-id"],
    ["the deadline is too long", { nowSeconds: NOW - 3600 }, "deadline"],
  ])("rejects when %s", (_name, over, expected) => {
    expect(code(() => checkExitPlan({ tx, pool, user: USER, tokenId, nowSeconds: NOW, ...over } as Parameters<typeof checkExitPlan>[0]))).toBe(expected);
  });
  it.each([
    ["an extra action (TAKE_PORTION fee step)", [0x01, 0x03, 0x11, 0x10], [dec(), burn(), take(), take(FEE)], "exit-actions"],
    ["missing BURN", [0x01, 0x11], [dec(), take()], "exit-actions"],
    ["reordered actions", [0x03, 0x01, 0x11], [burn(), dec(), take()], "exit-actions"],
    ["burning a different NFT", [0x01, 0x03, 0x11], [dec(), burn(5n), take()], "token-id"],
    ["TAKE_PAIR to the fee wallet", [0x01, 0x03, 0x11], [dec(), burn(), take(FEE)], "fee"],
    ["TAKE_PAIR to a third party", [0x01, 0x03, 0x11], [dec(), burn(), take("0x2222222222222222222222222222222222222222")], "take-recipient"],
    ["TAKE_PAIR of other currencies", [0x01, 0x03, 0x11], [dec(), burn(), take(USER, pool.currency1.address, pool.currency0.address)], "pool-key"],
  ])("rejects %s", (_name, actions, params, expected) => {
    expect(code(() => checkExitPlan({ tx: { ...tx, data: forge(actions as number[], params as Hex[]) }, pool, user: USER, tokenId, nowSeconds: NOW, feeRecipient: FEE }))).toBe(expected);
  });
  it("still rejects a third-party recipient when the fee wallet is unknown (client side)", () => {
    expect(code(() => checkExitPlan({ tx: { ...tx, data: forge([0x01, 0x03, 0x11], [dec(), burn(), take(FEE)]) }, pool, user: USER, tokenId }))).toBe("take-recipient");
  });
});
