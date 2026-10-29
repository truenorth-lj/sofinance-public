// @vitest-environment happy-dom
import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { buildExitModifyLiquidities } from "@sofinance/engine/protocols/uniswap-v4/tx-exit-posm";
import { afterEach, describe, expect, it } from "vitest";
import { checkExitTx, isDeadlinePassed, readWalletBalances, trackedPositionIds, trackPositionId, untrackPositionId } from "./exit-execute";

const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const USER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const built = (user: `0x${string}` = USER, tokenId = 4077059n) => buildExitModifyLiquidities({ pool, user, tokenId, liquidity: 10n, amount0Min: 1n, amount1Min: 1n, nowSeconds: 1_800_000_000 });
const view = (over: Record<string, unknown> = {}) => { const t = built(); return { from: t.from, to: t.to, data: t.data, value: "0x0", chainId: 4663, gasLimit: "323205", ...over }; };

afterEach(() => localStorage.clear());

describe("checkExitTx", () => {
  it("accepts the server's exit for this NFT", () => {
    expect(() => checkExitTx(view() as never, USER, "4077059", pool)).not.toThrow();
  });
  it.each([
    ["to is not the PositionManager", view({ to: UNIV4_RHC.universalRouter }), /unexpected contract/],
    ["value is not 0", view({ value: "0x1" }), /sends native ETH/],
    ["chain is not 4663", view({ chainId: 1 }), /not for Robinhood Chain/],
    ["from is another wallet", view({ from: OTHER }), /not from the connected wallet/],
    ["tokens go to someone else", view({ data: built(OTHER).data }), /safety check \(Exit tokens must go to the position owner\)/],
    ["it closes a different NFT", view({ data: built(USER, 5n).data }), /safety check/],
  ])("refuses when %s", (_name, tx, message) => {
    expect(() => checkExitTx(tx as never, USER, "4077059", pool)).toThrow(message);
  });
  it("detects an expired preview", () => {
    expect(isDeadlinePassed("100", 100)).toBe(true);
    expect(isDeadlinePassed("101", 100)).toBe(false);
  });
});

describe("tracked position ids", () => {
  it("remembers ids per wallet (newest first, max 10), and forgets on remove", () => {
    trackPositionId(USER, "1"); trackPositionId(USER, "2"); trackPositionId(USER.toUpperCase().replace("0X", "0x"), "1");
    expect(trackedPositionIds(USER)).toEqual(["1", "2"]);
    expect(trackedPositionIds(OTHER)).toEqual([]);
    for (let i = 3; i < 20; i++) trackPositionId(USER, String(i));
    expect(trackedPositionIds(USER)).toHaveLength(10);
    expect(untrackPositionId(USER, "19")).not.toContain("19");
  });
  it("ignores corrupted storage", () => {
    localStorage.setItem(`sofi:rhc:positions:${USER}`, "{oops");
    expect(trackedPositionIds(USER)).toEqual([]);
    localStorage.setItem(`sofi:rhc:positions:${USER}`, JSON.stringify(["7", 8, "x"]));
    expect(trackedPositionIds(USER)).toEqual(["7"]);
  });
});

describe("readWalletBalances", () => {
  it("uses only read-only wallet calls", async () => {
    const methods: string[] = [];
    const provider = { request: async ({ method }: { method: string }) => { methods.push(method); return method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x05"; } };
    const r = await readWalletBalances(provider, USER, [pool.currency0.address, pool.currency1.address]);
    expect(r.eth).toBe(10n ** 18n);
    expect(r.tokens[pool.currency0.address.toLowerCase()]).toBe(5n);
    expect(methods.sort()).toEqual(["eth_call", "eth_call", "eth_getBalance"]);
  });
});
