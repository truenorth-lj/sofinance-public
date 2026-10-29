// @vitest-environment happy-dom

import type { OpenFlowResult } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EstimatedAprBadge, OpenPreview, type RhcPoolView, RhcUniv4OpenPanel, StepList } from "./rhc-univ4-open-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPCX = "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", SPCXON = "0x9B8294F24453379aa87C807ab82bf1d5722153Fc";
const USER = "0x2222222222222222222222222222222222222222";
const apr = (source: "dexscreener" | "geckoterminal") => ({
  estimated: true as const, label: { zh: "估計", en: "Estimated" }, source, estimatedPoolFeeAprPct: 7.5, volume24hUsd: 1, tvlUsd: 1, feeRatePips: 100,
  attribution: source === "geckoterminal" ? { text: "Data: GeckoTerminal" as const, url: "https://www.geckoterminal.com" as const } : null,
}) as unknown as RhcPoolView["estimatedApr"];
const pool = (over: Partial<RhcPoolView> = {}): RhcPoolView => ({
  poolId: `0x${"ab".repeat(32)}`, status: "listed", tick: -1, price: 0.9999,
  token0: { address: SPCX, symbol: "SPCX", decimals: 18 }, token1: { address: SPCXON, symbol: "SPCXon", decimals: 18 },
  estimatedApr: apr("dexscreener"), ...over,
});
const plan = {
  kind: "swap", depositToken: SPCX, amountIn: "1000000000000000000", swapIn: "480000000000000000", quoteOut: "479000000000000000", minOut: "478000000000000000",
  fee: "479000000000000", liquidity: "1", amount0Max: "1", amount1Max: "1", priceTolBps: 20, slippageBps: 20, ticksCrossed: [], iterations: 3,
  sqrtPriceBeforeX96: "1", sqrtPriceAfterX96: "1", blockNumber: "98425782", feeRecipient: SPCX, feeRecipientIsPlaceholder: true,
};
const leftover = { pctOfDeposit: 2.5, display: "2.5", refund0: "1", refund1: "1",
  message: { zh: "約 2.5% 無法放進區間，會在同一筆交易退回你的錢包", en: "About 2.5% won't fit in the range and is returned to your wallet in the same transaction" } };
const needsSig = (approval: boolean) => ({
  state: "needs_signature", plan, leftover, typedData: {}, permit: {}, simulation: { status: "success", gasUsed: "412345", revert: null, checks: null },
  approvalTx: approval ? { from: USER, to: SPCX, data: "0x", value: "0x0", chainId: 4663 } : null,
}) as unknown as OpenFlowResult;

let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); delete (window as unknown as { ethereum?: unknown }).ethereum; });
const render = (el: Parameters<Root["render"]>[0]) => act(() => root.render(el));
const text = () => container.textContent ?? "";

describe("EstimatedAprBadge", () => {
  it("labels 估計/Estimated and shows no attribution for DexScreener data", () => {
    render(createElement(EstimatedAprBadge, { apr: apr("dexscreener") }));
    expect(text()).toContain("7.50%");
    expect(text()).toContain("估計 · Estimated APR");
    expect(container.querySelector("a")).toBeNull();
    expect(text()).not.toContain("GeckoTerminal");
  });
  it("links Data: GeckoTerminal only when GeckoTerminal data is shown", () => {
    render(createElement(EstimatedAprBadge, { apr: apr("geckoterminal") }));
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Data: GeckoTerminal");
    expect(link.getAttribute("href")).toBe("https://www.geckoterminal.com");
    expect(link.getAttribute("rel")).toContain("noopener");
  });
  it("says unavailable without data", () => {
    render(createElement(EstimatedAprBadge, { apr: null }));
    expect(text()).toBe("APR unavailable");
  });
});

describe("OpenPreview", () => {
  it("shows swap, fee, the leftover refund note (zh + en) and the placeholder fee wallet", () => {
    render(createElement(OpenPreview, { result: needsSig(true), pool: pool() }));
    expect(text()).toContain("Swap 0.48 SPCX → ≈0.479 SPCXon");
    expect(text()).toContain("SoFinance fee 0.10% of the swap output: 0.000479 SPCXon");
    const note = container.querySelector("[data-testid=leftover-note]")!.textContent!;
    expect(note).toContain("約 2.5% 無法放進區間，會在同一筆交易退回你的錢包");
    expect(note).toContain("About 2.5% won't fit in the range and is returned to your wallet in the same transaction");
    expect(container.querySelector("[data-testid=fee-placeholder]")).not.toBeNull();
    expect(container.querySelector("[data-testid=retry-notice]")).toBeNull();
  });
  it("shows the PM re-quote wording on confirm_again", () => {
    const r = { ...needsSig(false), state: "confirm_again", attempt: 1, tx: {}, gas: { estimate: "1", limit: "500000" } } as unknown as OpenFlowResult;
    render(createElement(OpenPreview, { result: r, pool: pool() }));
    expect(container.querySelector("[data-testid=retry-notice]")!.textContent).toContain("價格剛變動，已重新報價，請再確認一次");
  });
  it("shows the failure message", () => {
    render(createElement(OpenPreview, { result: { state: "failed", code: "retry-budget", message: "Price moved again" } as OpenFlowResult, pool: pool() }));
    expect(container.querySelector("[role=alert]")!.textContent).toBe("Price moved again");
  });
});

describe("StepList", () => {
  it("renders 1/3 approve → sign → execute with every button disabled while signing is off", () => {
    render(createElement(StepList, { needsApproval: true, current: "approve", signingEnabled: false }));
    expect([...container.querySelectorAll("li[data-step]")].map(li => li.getAttribute("data-step"))).toEqual(["approve", "sign", "execute"]);
    expect(text()).toContain("Step 1/3");
    expect([...container.querySelectorAll("button")].every(b => b.disabled)).toBe(true);
    expect(container.querySelector("[data-testid=signing-disabled]")!.textContent).toMatch(/off until real signing is approved \(PR6\)/);
  });
  it("is 1/2 without the approve step", () => {
    render(createElement(StepList, { needsApproval: false, current: "sign", signingEnabled: false }));
    expect(text()).toContain("Step 1/2");
    expect(text()).toContain("Step 2/2");
  });
});

describe("RhcUniv4OpenPanel", () => {
  it("connects MetaMask on 4663, previews via the server and never sends a signing request", async () => {
    const methods: string[] = [];
    (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn(async ({ method }: { method: string }) => {
      methods.push(method);
      return method === "eth_requestAccounts" ? [USER] : method === "eth_chainId" ? "0x1237" : null;
    }) };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => needsSig(true) }));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(RhcUniv4OpenPanel, { pool: pool({ estimatedApr: apr("geckoterminal") }), signingEnabled: false }));
    expect(text()).toContain("Data: GeckoTerminal");
    const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
    expect(button("Preview open (simulated)").disabled).toBe(true);
    await act(async () => { button("Connect MetaMask").click(); await new Promise(r => setTimeout(r, 300)); });
    expect(container.querySelector("[data-testid=wallet-address]")!.textContent).toContain("0x2222…2222");
    await act(async () => { button("Preview open (simulated)").click(); await new Promise(r => setTimeout(r, 0)); });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "prepare", user: USER, depositToken: SPCX, amount: "1000000000000000000", tickLower: -11, tickUpper: 9 });
    expect(container.querySelector("[data-testid=leftover-note]")).not.toBeNull();
    expect(text()).toContain("Step 1/3");
    expect([...container.querySelectorAll("li[data-step] button")].every(b => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(methods.filter(m => !["eth_requestAccounts", "eth_chainId"].includes(m))).toEqual([]);
  });
  it("blocks opening a delisted pool", () => {
    render(createElement(RhcUniv4OpenPanel, { pool: pool({ status: "delisted" }), signingEnabled: false }));
    expect(text()).toContain("This pool is delisted");
  });
});
