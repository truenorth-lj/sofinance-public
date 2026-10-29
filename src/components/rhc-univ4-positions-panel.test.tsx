// @vitest-environment happy-dom

import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { buildExitModifyLiquidities } from "@sofinance/engine/protocols/uniswap-v4/tx-exit-posm";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ signing: true }));
vi.mock("@/lib/protocol-flags", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/protocol-flags")>(), isRhcUniv4WalletSigningEnabled: () => flags.signing }));

import { RhcUniv4PositionsPanel } from "./rhc-univ4-positions-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const USER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const ID = "4077059";
const HASH = `0x${"cd".repeat(32)}`;
const position = (over: Record<string, unknown> = {}) => ({ tokenId: ID, owner: USER, ownedByUser: true, liquidity: "29340323272345554694", tickLower: -11, tickUpper: 9, poolId: pool.poolId, baseSymbol: pool.baseSymbol, ...over });
const ready = (recipient: `0x${string}` = USER, nowSeconds = Math.floor(Date.now() / 1000)) => {
  const t = buildExitModifyLiquidities({ pool, user: recipient, tokenId: BigInt(ID), liquidity: 29340323272345554694n, amount0Min: 13149176925997666n, amount1Min: 16035615754754612n, nowSeconds });
  return {
    state: "ready", position: position(), expected: { amount0: "13215253191957454", amount1: "16116196738446847" }, min: { amount0: "13149176925997666", amount1: "16035615754754612" },
    slippageBps: 50, tx: { from: USER, to: UNIV4_RHC.positionManager, data: t.data, value: "0x0", chainId: 4663, gasLimit: "323205" },
    gas: { estimate: "258564", limit: "323205", gasPrice: "20654000", maxCostWei: "6675476070000" },
    simulation: { gasUsed: "216652", amount0: "1", amount1: "1", burned: true, otherTransfers: [] }, blockNumber: "100997267", deadline: String(nowSeconds + 600),
  };
};

let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { flags.signing = true; act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label);
const tick = (ms = 20) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function mount({ positions = [{ tokenId: ID, position: position() }] as unknown[], prepare = ready() as unknown, receipt = { status: "0x1", logs: [] } as unknown,
  send = (): unknown => HASH, signingEnabled = true } = {}) {
  localStorage.setItem(`sofi:rhc:positions:${USER}`, JSON.stringify([ID]));
  const calls: { method: string; params?: unknown }[] = [];
  const provider = { request: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_sendTransaction") return send();
    if (method === "eth_getTransactionReceipt") return receipt;
    return null;
  }) };
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const json = body.action === "positions" ? { state: "positions", positions } : prepare;
    return { ok: true, status: (json as { state?: string }).state === "failed" ? 422 : 200, json: async () => json };
  });
  vi.stubGlobal("fetch", fetchMock);
  const onChanged = vi.fn();
  await act(async () => { root.render(createElement(RhcUniv4PositionsPanel, { wallet: { provider, address: USER }, signingEnabled, onChanged, receiptPoll: { intervalMs: 1, timeoutMs: 50 } })); });
  await tick();
  const bodies = () => fetchMock.mock.calls.map(c => JSON.parse((c[1] as RequestInit).body as string));
  const sends = () => calls.filter(c => c.method === "eth_sendTransaction");
  const alert = () => container.querySelector("[role=alert]")?.textContent ?? null;
  return { calls, bodies, sends, alert, onChanged };
}

describe("RhcUniv4PositionsPanel", () => {
  it("lists tracked positions by NFT id and previews a close with no fee (nothing sent)", async () => {
    const p = await mount();
    expect(p.bodies()[0]).toEqual({ action: "positions", user: USER, tokenIds: [ID] });
    expect(text()).toContain("#4077059 · SPCX / SPCXon · ticks -11 to 9");
    await act(async () => { button("Close")!.click(); });
    await tick();
    expect(p.bodies()[1]).toEqual({ action: "prepare", user: USER, tokenId: ID });
    const preview = container.querySelector("[data-testid=close-preview]")!.textContent!;
    expect(preview).toContain("≈ 0.013215 SPCX + 0.016116 SPCXon");
    expect(preview).toContain("No SoFinance fee on closing");
    expect(preview).toContain("0.5% price protection");
    expect(p.sends()).toEqual([]);
  });

  it("sends exactly one guarded close to the PositionManager, shows the tx link, then refreshes positions and balances", async () => {
    const p = await mount();
    await act(async () => { button("Close")!.click(); });
    await tick();
    await act(async () => { button("Confirm close in wallet")!.click(); });
    await tick(50);
    expect(p.sends()).toHaveLength(1);
    const [params] = p.sends()[0]!.params as [Record<string, string>];
    expect(params).toMatchObject({ from: USER, to: UNIV4_RHC.positionManager, value: "0x0", gas: "0x" + (323205).toString(16) });
    const ok = container.querySelector("[data-testid=close-success]")!;
    expect(ok.textContent).toContain("Closed.");
    expect(ok.querySelector("a")!.getAttribute("href")).toBe(`https://robinhoodchain.blockscout.com/tx/${HASH}`);
    expect(p.onChanged).toHaveBeenCalledTimes(1);
    expect(p.bodies().filter(b => b.action === "positions")).toHaveLength(2);
    expect(p.alert()).toBeNull();
  });

  it("shows a failed close with its tx link", async () => {
    await mount({ receipt: { status: "0x0", logs: [] } });
    await act(async () => { button("Close")!.click(); });
    await tick();
    await act(async () => { button("Confirm close in wallet")!.click(); });
    await tick(50);
    const failed = container.querySelector("[data-testid=close-reverted]")!;
    expect(failed.textContent).toMatch(/failed on chain, so your position is still open/);
    expect(failed.querySelector("a")).not.toBeNull();
  });

  it("refuses to send when the server's calldata pays anyone but the owner", async () => {
    const p = await mount({ prepare: ready(OTHER) });
    await act(async () => { button("Close")!.click(); });
    await tick();
    await act(async () => { button("Confirm close in wallet")!.click(); });
    await tick();
    expect(p.alert()).toMatch(/safety check.*nothing was sent/);
    expect(p.sends()).toEqual([]);
  });

  it("asks to preview again when the close preview expired", async () => {
    const p = await mount({ prepare: ready(USER, Math.floor(Date.now() / 1000) - 700) });
    await act(async () => { button("Close")!.click(); });
    await tick();
    await act(async () => { button("Confirm close in wallet")!.click(); });
    await tick();
    expect(p.alert()).toMatch(/expired\. Preview again/);
    expect(p.sends()).toEqual([]);
  });

  it("shows the server's plain-language failure (not enough ETH for gas)", async () => {
    const message = "Not enough ETH on Robinhood Chain to pay the gas for closing (need about 0.0000067 ETH, wallet has 0 ETH). Add some ETH, then try again.";
    const p = await mount({ prepare: { state: "failed", code: "insufficient-gas", message } });
    await act(async () => { button("Close")!.click(); });
    await tick();
    expect(p.alert()).toBe(message);
  });

  it("maps a wallet 'insufficient funds' error to plain words", async () => {
    const p = await mount({ send: () => { throw Object.assign(new Error("Internal JSON-RPC error."), { code: -32603, data: { message: "insufficient funds for gas * price + value" } }); } });
    await act(async () => { button("Close")!.click(); });
    await tick();
    await act(async () => { button("Confirm close in wallet")!.click(); });
    await tick();
    expect(p.alert()).toMatch(/Not enough ETH on Robinhood Chain to pay for gas\. Add some ETH/);
  });

  it("keeps Confirm disabled while wallet signing is off", async () => {
    flags.signing = false;
    const p = await mount({ signingEnabled: false });
    await act(async () => { button("Close")!.click(); });
    await tick();
    expect(button("Confirm close in wallet")!.disabled).toBe(true);
    expect(text()).toContain("Wallet signing is off");
    expect(p.sends()).toEqual([]);
  });

  it("shows positions it cannot close without a Close button", async () => {
    await mount({ positions: [
      { tokenId: "1", position: position({ tokenId: "1", owner: OTHER, ownedByUser: false }) },
      { tokenId: "2", position: null, error: "not-found" },
      { tokenId: "3", position: position({ tokenId: "3", poolId: null, baseSymbol: null }) },
    ] });
    expect(button("Close")).toBeUndefined();
    expect(text()).toContain("Owned by another wallet (0x2222…2222).");
    expect(text()).toContain("Closed (or never existed).");
    expect(text()).toContain("Not in a pool SoFinance supports.");
  });

  it("adds a position by NFT number", async () => {
    const p = await mount({ positions: [] });
    const input = container.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "77"); input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Add")!.click(); });
    await tick();
    expect(p.bodies().at(-1)).toEqual({ action: "positions", user: USER, tokenIds: ["77", ID] });
  });
});
