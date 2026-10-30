// @vitest-environment happy-dom

import type { OpenFlowResult } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ signing: false }));
vi.mock("@/lib/protocol-flags", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/protocol-flags")>(), isRhcUniv4WalletSigningEnabled: () => flags.signing }));

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
  sqrtPriceBeforeX96: "1", sqrtPriceAfterX96: "1", blockNumber: "98425782", feeRecipient: SPCX,
};
const leftover = { pctOfDeposit: 2.5, display: "2.5", refund0: "1", refund1: "1",
  message: { zh: "約 2.5% 無法放進區間，會在同一筆交易退回你的錢包", en: "About 2.5% won't fit in the range and is returned to your wallet in the same transaction" } };
const needsSig = (approval: boolean) => ({
  state: "needs_signature", plan, leftover, typedData: {}, permit: {}, simulation: { status: "success", gasUsed: "412345", revert: null, checks: null },
  approvalTx: approval ? { from: USER, to: SPCX, data: "0x", value: "0x0", chainId: 4663 } : null,
}) as unknown as OpenFlowResult;

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  // Fresh storage avoids Happy DOM bound proxy spies leaking across fault-injection tests.
  const records = new Map<string, string>();
  const storage: Storage = {
    get length() { return records.size; }, key: index => [...records.keys()][index] ?? null,
    getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); },
    removeItem: key => { records.delete(key); }, clear: () => records.clear(),
  };
  vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { flags.signing = false; localStorage.clear(); act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as { ethereum?: unknown }).ethereum; });
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
  it("shows — (not 0.00%) without data", () => {
    render(createElement(EstimatedAprBadge, { apr: null }));
    expect(container.querySelector("[data-testid=estimated-apr]")!.firstElementChild!.textContent).toBe("—");
    expect(text()).not.toContain("0.00%");
  });
  it("shows — (not 0.00%) when TVL is 0 or the value is missing", () => {
    render(createElement(EstimatedAprBadge, { apr: { ...apr("dexscreener"), estimatedPoolFeeAprPct: null } as RhcPoolView["estimatedApr"] }));
    expect(text()).toContain("—");
    expect(text()).not.toContain("0.00%");
    render(createElement(EstimatedAprBadge, { apr: { ...apr("dexscreener"), estimatedPoolFeeAprPct: undefined } as unknown as RhcPoolView["estimatedApr"] }));
    expect(text()).not.toContain("0.00%");
  });
  it("shows a real but tiny APR as <0.01% with its basis (the 2026-10-30 prod SPCX/SPCXon case)", () => {
    render(createElement(EstimatedAprBadge, { apr: { ...apr("dexscreener"), estimatedPoolFeeAprPct: 0.0005575645952321763,
      feeRatePct: 0.005, volume24hUsd: 14.76, tvlUsd: 48795.01 } as RhcPoolView["estimatedApr"] }));
    expect(text()).toContain("<0.01%");
    expect(text()).not.toContain("0.00%");
    expect(container.querySelector("[data-testid=estimated-apr-basis]")!.textContent).toBe("0.005% fee × $15 24h vol / $48,795 TVL");
  });
});

describe("OpenPreview", () => {
  it("shows swap, fee and the leftover refund note (zh + en); no placeholder note", () => {
    render(createElement(OpenPreview, { result: needsSig(true), pool: pool() }));
    expect(text()).toContain("Swap 0.48 SPCX → ≈0.479 SPCXon");
    expect(text()).toContain("SoFinance fee 0.10% of the swap output: 0.000479 SPCXon");
    const note = container.querySelector("[data-testid=leftover-note]")!.textContent!;
    expect(note).toContain("約 2.5% 無法放進區間，會在同一筆交易退回你的錢包");
    expect(note).toContain("About 2.5% won't fit in the range and is returned to your wallet in the same transaction");
    expect(container.querySelector("[data-testid=fee-placeholder]")).toBeNull();
    expect(text()).not.toMatch(/placeholder|TBD/i);
    expect(container.querySelector("[data-testid=retry-notice]")).toBeNull();
  });
  it("shows 'fee wallet not configured' when the server fails closed", () => {
    const r = { state: "failed", code: "fee-wallet-unconfigured", message: "Fee wallet not configured; opening is disabled" } as OpenFlowResult;
    render(createElement(OpenPreview, { result: r, pool: pool() }));
    expect(container.querySelector("[role=alert]")!.textContent).toBe("Fee wallet not configured; opening is disabled");
    expect(container.querySelector("[data-testid=open-preview]")).toBeNull();
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
    expect(container.querySelector("[data-testid=signing-disabled]")!.textContent).toMatch(/Wallet signing is currently disabled here/);
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
    expect(methods.filter(m => !["eth_requestAccounts", "eth_chainId", "eth_getBalance", "eth_call"].includes(m))).toEqual([]);
  });
  it("blocks opening a delisted pool", () => {
    render(createElement(RhcUniv4OpenPanel, { pool: pool({ status: "delisted" }), signingEnabled: false }));
    expect(text()).toContain("This pool is delisted");
  });
});

const UR = "0x204FAca1764B154221e35c0d20aBb3c525710498";
const PM = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const SIG = `0x${"11".repeat(65)}`, HASH = `0x${"cd".repeat(32)}`;
const permitJson = (sigDeadline = String(Math.floor(Date.now() / 1000) + 600)) =>
  ({ details: { token: SPCX, amount: "1000000000000000000", expiration: Math.floor(Date.now() / 1000) + 1800, nonce: 3 }, spender: UR, sigDeadline });
const prepared = (sigDeadline?: string) => ({ ...(needsSig(false) as object), typedData: { primaryType: "PermitSingle" }, permit: permitJson(sigDeadline) }) as unknown as OpenFlowResult;
const ready = (tx: Record<string, unknown> = {}) => ({
  state: "ready", attempt: 0, plan, leftover, simulation: { status: "success", gasUsed: "685843", revert: null, checks: null }, gas: { estimate: "765000", limit: "957060" },
  tx: { from: USER, to: UR, data: "0x3593564c", value: "0x0", gasLimit: "957060", chainId: 4663, ...tx },
}) as unknown as OpenFlowResult;
const mintReceipt = { transactionHash: HASH, status: "0x1", logs: [{ address: PM, topics: [
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${"0".repeat(64)}`, `0x${"0".repeat(24)}${USER.slice(2)}`, `0x${(1234).toString(16).padStart(64, "0")}`,
] }] };

/** Signing-enabled panel with a mocked MetaMask + server; returns the wallet calls and fetch bodies. */
async function signingPanel({ prepare = prepared(), finalize = ready(), chainAtSend = "0x1237" }: { prepare?: OpenFlowResult; finalize?: unknown; chainAtSend?: string } = {}) {
  flags.signing = true;
  const calls: { method: string; params?: unknown }[] = [];
  let chain = "0x1237";
  const listeners = new Map<string, (...args: unknown[]) => void>();
  (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push({ method, params });
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [USER];
    if (method === "eth_chainId") return chain;
    if (method === "eth_signTypedData_v4") { chain = chainAtSend; return SIG; }
    if (method === "eth_sendTransaction") return HASH;
    if (method === "eth_getTransactionReceipt") return mintReceipt;
    return null;
  }), on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    removeListener: (event: string) => listeners.delete(event) };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/rhc-univ4-exit") return { ok: true, json: async () => ({ state: "positions", positions: [] }) };
    const action = JSON.parse(init.body as string).action;
    return { ok: true, json: async () => (action === "prepare" ? prepare : finalize) };
  });
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(RhcUniv4OpenPanel, { pool: pool(), signingEnabled: true, receiptPoll: { intervalMs: 1, timeoutMs: 50 } }));
  const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
  await act(async () => { button("Connect MetaMask").click(); await new Promise(r => setTimeout(r, 300)); });
  await act(async () => { button("Preview open (simulated)").click(); await new Promise(r => setTimeout(r, 0)); });
  const stepButton = (id: string) => container.querySelector(`li[data-step=${id}] button`) as HTMLButtonElement;
  const click = (id: string) => act(async () => { stepButton(id).click(); await new Promise(r => setTimeout(r, 20)); });
  const bodies = () => fetchMock.mock.calls.filter(c => c[0] !== "/api/rhc-univ4-exit").map(c => JSON.parse((c[1] as RequestInit).body as string));
  const exitBodies = () => fetchMock.mock.calls.filter(c => c[0] === "/api/rhc-univ4-exit").map(c => JSON.parse((c[1] as RequestInit).body as string));
  const sends = () => calls.filter(c => c.method === "eth_sendTransaction");
  const alert = () => container.querySelector("[role=alert]")?.textContent ?? null;
  return { calls, bodies, exitBodies, sends, stepButton, click, alert, emit: (event: string) => listeners.get(event)?.() };
}

describe("RhcUniv4OpenPanel signing (preview flag on)", () => {
  it("passes the wallet signature + prepare permit to finalize, then sends exactly one execute to the pinned UR", async () => {
    const prep0 = prepared();
    const p = await signingPanel({ prepare: prep0 });
    expect(p.stepButton("sign").disabled).toBe(false);
    expect(p.stepButton("execute").disabled).toBe(true);
    await p.click("sign");
    const sign = p.calls.find(c => c.method === "eth_signTypedData_v4")!;
    expect(sign.params).toEqual([USER, JSON.stringify({ primaryType: "PermitSingle" })]);
    const [prep, fin] = p.bodies();
    expect(fin).toEqual({ ...prep, action: "finalize", attempt: 0, signature: SIG, permit: (prep0 as { permit: unknown }).permit });
    expect(fin).toMatchObject({ poolId: pool().poolId, user: USER, depositToken: SPCX, amount: "1000000000000000000", tickLower: -11, tickUpper: 9 });
    expect(p.sends()).toEqual([]);
    expect(p.stepButton("execute").disabled).toBe(false);
    await p.click("execute");
    expect(p.sends()).toEqual([{ method: "eth_sendTransaction", params: [{ from: USER, to: UR, data: "0x3593564c", value: "0x0", gas: "0x" + (957060).toString(16) }] }]);
    expect(p.calls.some(c => c.method === "eth_getTransactionReceipt")).toBe(true);
    const status = container.querySelector("[data-testid=tx-execute]")!;
    expect(status.textContent).toContain("confirmed");
    expect(status.textContent).toContain("Position NFT #1234");
    expect(status.querySelector("a")!.getAttribute("href")).toBe(`https://robinhoodchain.blockscout.com/tx/${HASH}`);
    expect(p.alert()).toBeNull();
    expect(p.stepButton("execute").disabled).toBe(true);
    // PR7: the minted NFT is remembered for the Close list, positions + balances refresh after the confirmed tx.
    expect(JSON.parse(localStorage.getItem(`sofi:rhc:positions:${USER}`)!)).toEqual(["1234"]);
    expect(p.exitBodies().at(-1)).toEqual({ action: "positions", user: USER, tokenIds: ["1234"] });
    expect(p.calls.filter(c => c.method === "eth_getBalance").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector("[data-testid=wallet-balances]")).not.toBeNull();
  });
  it("shows finalize errors and never sends", async () => {
    const p = await signingPanel({ finalize: { state: "failed", code: "simulation-reverted", message: "Simulation reverted: X" } });
    await p.click("sign");
    expect(p.alert()).toBe("Simulation reverted: X");
    expect(p.stepButton("execute").disabled).toBe(true);
    expect(p.sends()).toEqual([]);
  });
  it.each([
    ["to is not the Universal Router", { to: SPCX }, /unexpected contract/],
    ["value is not zero", { value: "0x1" }, /sends native ETH/],
    ["tx chainId is not 4663", { chainId: 1 }, /not for Robinhood Chain/],
    ["from is not the connected wallet", { from: SPCXON }, /not from the connected wallet/],
  ])("refuses execute when %s and never calls the wallet", async (_name, tx, message) => {
    const p = await signingPanel({ finalize: ready(tx) });
    await p.click("sign");
    await p.click("execute");
    expect(p.alert()).toMatch(message);
    expect(p.sends()).toEqual([]);
  });
  it("refuses execute when the wallet is not on chain 4663", async () => {
    const p = await signingPanel({ chainAtSend: "0x1" });
    await p.click("sign");
    await p.click("execute");
    expect(p.alert()).toMatch(/not on Robinhood Chain/);
    expect(p.sends()).toEqual([]);
  });
  it("asks to preview again when the Permit2 sigDeadline has passed", async () => {
    const p = await signingPanel({ prepare: prepared(String(Math.floor(Date.now() / 1000) - 1)) });
    await p.click("sign");
    expect(p.alert()).toMatch(/expired\. Preview again/);
    expect(p.calls.some(c => c.method === "eth_signTypedData_v4")).toBe(false);
    expect(p.bodies().length).toBe(1);
  });
  it("maps a server-side expiry to the preview-again message", async () => {
    const p = await signingPanel({ finalize: { state: "failed", code: "permit-mismatch", message: "Permit2 signature expired; please sign again" } });
    await p.click("sign");
    expect(p.alert()).toMatch(/expired\. Preview again/);
  });
});

describe("review 20261030 additional safety probes", () => {
  it("SAFETY: unmount during chain check prevents a later wallet send", async () => {
    const p = await signingPanel(); await p.click("sign");
    const provider = (window as unknown as { ethereum: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
    const original = provider.request;
    let release!: (value: unknown) => void; let held = false;
    provider.request = async args => {
      if (args.method === "eth_chainId" && !held) { held = true; return new Promise(r => { release = r; }); }
      return original(args);
    };
    await p.click("execute"); expect(release).toBeTypeOf("function");
    await act(async () => { root.render(null); });
    await act(async () => { release("0x1237"); await new Promise(r => setTimeout(r, 20)); });
    expect(p.sends()).toHaveLength(0);
  });
  it("SAFETY: unknown wallet transport errors do not claim definitely unsent", async () => {
    const p = await signingPanel(); await p.click("sign");
    const provider = (window as unknown as { ethereum: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
    const original = provider.request;
    provider.request = async args => {
      if (args.method === "eth_sendTransaction") throw new Error("response lost after node accepted transaction");
      return original(args);
    };
    await p.click("execute");
    expect(p.alert()).not.toContain("Nothing was sent");
    expect(p.stepButton("execute").disabled).toBe(true);
  });
  it("SAFETY: pending transaction survives a panel remount", async () => {
    const p = await signingPanel(); await p.click("sign");
    const provider = (window as unknown as { ethereum: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
    const original = provider.request;
    provider.request = async args => args.method === "eth_getTransactionReceipt" ? null : original(args);
    await p.click("execute");
    await act(async () => { await new Promise(r => setTimeout(r, 70)); });
    expect(p.sends()).toHaveLength(1);
    expect(container.querySelector("[data-testid=tx-execute]")).not.toBeNull();
    await act(async () => root.render(null));
    await act(async () => { root.render(createElement(RhcUniv4OpenPanel, { pool: pool(), signingEnabled: true,
      initialWallet: { provider, address: USER, name: "mock" }, receiptPoll: { intervalMs: 1, timeoutMs: 50 } })); await new Promise(r => setTimeout(r, 20)); });
    expect(container.querySelector(`a[href$="${HASH}"]`)).not.toBeNull();
  });
});


it("SAFETY: unknown wallet send outcome blocks a second send", async () => {
  const p = await signingPanel(); await p.click("sign");
  const provider = (window as unknown as { ethereum: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
  const original = provider.request; let attempted = 0;
  provider.request = async args => {
    if (args.method === "eth_sendTransaction") { attempted++; throw new Error("response lost after node accepted transaction"); }
    return original(args);
  };
  await p.click("execute"); await p.click("execute");
  expect(attempted).toBe(1);
});

const injectedProvider = () => (window as unknown as { ethereum: import("@/lib/rhc-wallet/eip1193").Eip1193Provider }).ethereum;
const pauseRequest = (method: string) => {
  const provider = injectedProvider(), original = provider.request;
  let release!: (value: unknown) => void;
  provider.request = args => args.method === method ? new Promise(resolve => { release = resolve; }) : original(args);
  return { release: (value: unknown) => release(value), original, provider };
};
const previewButton = () => [...container.querySelectorAll("button")].find(b => b.textContent === "Preview open (simulated)")!;

describe("RHC durable send and lifecycle", () => {
  it.each(["throw", "drop"])("does not ask the wallet to send if durable intent storage %s fails", async mode => {
    const p = await signingPanel(); await p.click("sign");
    const original = localStorage.setItem;
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(function(this: Storage, key, value) {
      if (key.includes("open-attempt")) { if (mode === "throw") throw new Error("quota"); return; }
      original.call(this, key, value);
    });
    try { await p.click("execute"); expect(spy).toHaveBeenCalled(); expect(p.sends()).toHaveLength(0); expect(p.alert()).toContain("Unable to verify"); }
    finally { spy.mockRestore(); }
  });
  it("clears an explicit user rejection and allows a new wallet request", async () => {
    const p = await signingPanel(); await p.click("sign");
    const provider = injectedProvider(), original = provider.request;
    provider.request = async args => { if (args.method === "eth_sendTransaction") throw Object.assign(new Error("rejected"), { code: 4001 }); return original(args); };
    await p.click("execute");
    expect(localStorage.getItem(`sofi:rhc:open-attempt:v1:4663:${USER}`)).toBeNull();
    expect(p.stepButton("execute").disabled).toBe(false);
    provider.request = original; await p.click("execute"); expect(p.sends()).toHaveLength(1);
  });
  it("retains unknown intent across reload and refuses another preview", async () => {
    const p = await signingPanel(); await p.click("sign");
    const provider = injectedProvider(), original = provider.request;
    provider.request = async args => { if (args.method === "eth_sendTransaction") throw new Error("connection lost"); return original(args); };
    await p.click("execute");
    const raw = localStorage.getItem(`sofi:rhc:open-attempt:v1:4663:${USER}`)!;
    expect(JSON.parse(raw)).toMatchObject({ hash: null, kind: "execute", wallet: USER });
    await act(async () => root.render(null));
    render(createElement(RhcUniv4OpenPanel, { pool: pool(), signingEnabled: true, initialWallet: { provider, address: USER, name: "mock" }, showPositions: false }));
    expect(previewButton().disabled).toBe(true);
    expect(text()).toContain("outcome is unknown");
    expect(localStorage.getItem(`sofi:rhc:open-attempt:v1:4663:${USER}`)).toBe(raw);
  });
  it("saves a late wallet hash after unmount without polling or opening a new position", async () => {
    const p = await signingPanel(); await p.click("sign");
    const held = pauseRequest("eth_sendTransaction");
    await p.click("execute");
    await act(async () => root.render(null));
    await act(async () => { held.release(HASH); await new Promise(r => setTimeout(r, 10)); });
    expect(JSON.parse(localStorage.getItem(`sofi:rhc:open-attempt:v1:4663:${USER}`)!)).toMatchObject({ hash: HASH });
    expect(p.calls.some(c => c.method === "eth_getTransactionReceipt")).toBe(false);
  });
  it("never finalizes a Permit2 signature returned after the input changes", async () => {
    const p = await signingPanel(); const held = pauseRequest("eth_signTypedData_v4");
    await p.click("sign");
    await act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { held.release(SIG); await new Promise(r => setTimeout(r, 10)); });
    expect(p.bodies()).toHaveLength(1);
    expect(p.sends()).toHaveLength(0);
  });
  it("refuses a changed account even when the provider does not emit an event", async () => {
    const p = await signingPanel(); await p.click("sign");
    const provider = injectedProvider(), original = provider.request;
    provider.request = async args => args.method === "eth_accounts" ? [SPCXON] : original(args);
    await p.click("execute"); expect(p.sends()).toHaveLength(0); expect(p.alert()).toContain("account changed");
  });
  it("rechecks the original receipt without reactivating an old execute button", async () => {
    const p = await signingPanel(); await p.click("sign");
    const provider = injectedProvider(), original = provider.request;
    provider.request = async args => args.method === "eth_getTransactionReceipt" ? {} : original(args);
    await p.click("execute");
    expect(p.stepButton("execute").disabled).toBe(true);
    provider.request = original;
    await act(async () => {
      [...container.querySelectorAll("button")].find(b => b.textContent === "Check original transaction")!.click();
      await new Promise(r => setTimeout(r, 20));
    });
    expect(p.sends()).toHaveLength(1);
    expect(container.querySelector("li[data-step=execute]")).toBeNull();
    expect(text()).toContain("Position NFT #1234");
    expect(localStorage.getItem(`sofi:rhc:open-attempt:v1:4663:${USER}`)).toBeNull();
  });
});

it.each(["accountsChanged", "chainChanged", "disconnect"])("revokes an in-flight send synchronously on %s", async event => {
  const p = await signingPanel(); await p.click("sign");
  const held = pauseRequest("eth_accounts"); await p.click("execute");
  await act(async () => { p.emit(event); held.release([USER]); await new Promise(r => setTimeout(r, 10)); });
  expect(p.sends()).toHaveLength(0);
  expect(p.stepButton("execute").disabled).toBe(true);
});
it("discards the old preview when the pool prop changes", async () => {
  const p = await signingPanel(); await p.click("sign");
  render(createElement(RhcUniv4OpenPanel, { pool: pool({ poolId: `0x${"ef".repeat(32)}` }), signingEnabled: true, showPositions: false }));
  expect(container.querySelector("li[data-step=execute]")).toBeNull();
  expect(p.sends()).toHaveLength(0);
});
it("preserves the approved flow and the explicit reverted-execute re-quote", async () => {
  const prep = { ...prepared(), approvalTx: { from: USER, to: SPCX, data: "0x", value: "0x0", chainId: 4663 } } as OpenFlowResult;
  const p = await signingPanel({ prepare: prep });
  await p.click("approve"); expect(p.stepButton("sign").disabled).toBe(false);
  await p.click("sign");
  const provider = injectedProvider(), original = provider.request;
  provider.request = async args => args.method === "eth_getTransactionReceipt" ? { transactionHash: HASH, status: "0x0" } : original(args);
  await p.click("execute");
  expect(p.bodies().at(-1)).toMatchObject({ action: "finalize", attempt: 1 });
  expect(p.stepButton("execute").disabled).toBe(false);
  expect(p.sends()).toHaveLength(2); // One approval and one execute; no automatic resend.
});

it("retains the pending transaction if its minted position cannot be saved", async () => {
  const p = await signingPanel(); await p.click("sign");
  const original = localStorage.setItem;
  const spy = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key.startsWith("sofi:rhc:positions:")) throw new Error("quota");
    original(key, value);
  });
  try {
    await p.click("execute");
    expect(p.sends()).toHaveLength(1);
    expect(p.alert()).toContain("Unable to verify");
    expect(JSON.parse(localStorage.getItem(`sofi:rhc:open-attempt:v1:4663:${USER}`)!)).toMatchObject({ hash: HASH });
    expect(p.stepButton("execute").disabled).toBe(true);
  } finally { spy.mockRestore(); }
});

it("revokes a retained execute callback after its transaction has confirmed", async () => {
  const p = await signingPanel(); await p.click("sign");
  const button = p.stepButton("execute");
  const propsKey = Object.keys(button).find(key => key.startsWith("__reactProps$"))!;
  const retained = (button as unknown as Record<string, { onClick: () => Promise<void> }>)[propsKey]!.onClick;
  await p.click("execute");
  await act(async () => { await retained(); });
  expect(p.sends()).toHaveLength(1);
});
