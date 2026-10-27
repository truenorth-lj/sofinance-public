// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { USDC_MINT } from "@sofinance/engine/ids";

// Framework routing boundary only. SelectedApp and both controllers are real.
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
const wallet = testKeypair(71).publicKey.toBase58();
const positionMint = testKeypair(72).publicKey.toBase58();
const mintB = testKeypair(73).publicKey.toBase58();
const state = { wallet, positionMint, inputMint: USDC_MINT, inputKind: "token", inputDecimals: 6,
  inputBalance: "1000000", ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
  mintA: USDC_MINT, mintB, decimalsA: 6, decimalsB: 9, currentAmounts: { a: "1000000", b: "1000000000" },
  balances: { a: "1000000", b: "1000000000" }, solLamports: 1000000000, price: "1", tickLower: 0, tickUpper: 10,
  slot: 1, liquidity: "1000000", rangeSide: "inside", inRange: true, poolId: testKeypair(74).publicKey.toBase58(),
  fees: { a: "1000", b: "0" }, rewards: [], eligible: true };
let root: Root, container: HTMLDivElement, connection: WalletConnection;
let calls: { path: string; body?: string; at: number }[], views: unknown[];
let quoteError: string;
let pendingQuote: Promise<Response> | undefined;
let release: (r: Response) => void;
let prepare: Promise<Response>;
let writes: ReturnType<typeof vi.spyOn>;
const count = (path: string) => calls.filter(c => c.path === path).length;
function button(label: string, scope = "button") {
  const b = [...container.querySelectorAll<HTMLButtonElement>(scope)].find(b => b.textContent === label);
  expect(b, label).toBeDefined(); return b!;
}
function snapshot(label: string) {
  views.push({ label, text: container.textContent, buttons: [...container.querySelectorAll<HTMLButtonElement>("button")].map(b => ({ text: b.textContent, disabled: b.disabled })),
    amount: container.querySelector<HTMLInputElement>("#amount")?.value });
}
async function click(label: string, scope?: string) { const b = button(label, scope); expect(b.disabled).toBe(false); await act(async () => b.click()); snapshot(label); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function ready() { await click("MAX"); await advance(450); expect(button("Add liquidity").disabled).toBe(false); snapshot("preview ready"); }
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); calls = []; views = []; quoteError = ""; pendingQuote = undefined;
  writes = vi.spyOn(localStorage, "setItem");
  prepare = new Promise(resolve => { release = resolve; });
  connection = { address: wallet, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false,
    walletsCount: 1, connectionError: "", signTransaction: vi.fn() };
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function(this: HTMLDialogElement) { this.setAttribute("open", ""); });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function(this: HTMLDialogElement) { this.removeAttribute("open"); });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body as string | undefined, at: Date.now() });
    if (path.startsWith("/api/wallet?")) return Response.json({ wallet, positions: [{ ...state, nftAccount: wallet }],
      assets: [{ kind: "token", mint: USDC_MINT, balance: "1000000", totalBalance: "1000000", decimals: 6, eligible: true, symbol: "USDC" }] });
    if (path.startsWith("/api/selected-state?")) return Response.json(state);
    if (path === "/api/compound-state") return Response.json(state);
    if (path === "/api/token-metadata") return Response.json({ tokens: { [USDC_MINT]: { mint: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6 }, [mintB]: { mint: mintB, symbol: "POOL", name: "Pool token", decimals: 9 } } });
    if (path === "/api/sol-usdc-price") return Response.json({ rate: 100, usdcUsd: 1 });
    if (path === "/api/selected-quote") {
      if (pendingQuote) return pendingQuote;
      if (quoteError) return Response.json({ error: "Original wire error", code: quoteError, outputMint: mintB }, { status: 400 });
      const body = JSON.parse(String(init?.body));
      return Response.json({ ...state, ...body, requested: "1000000", liquidity: "100", expiresAt: Date.now() + 75000,
        passesFloor: false, roundtripCostInput: null, spendA: "0", spendB: "0" });
    }
    if (path === "/api/selected-prepare" || path === "/api/compound-prepare") return prepare;
    throw new Error(`Unexpected HTTP boundary ${path}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<WalletConnectionContext.Provider value={connection}><SelectedApp initialView="deposit" /></WalletConnectionContext.Provider>));
  await advance(30); await advance(30); await advance(30);
});
it.each(["success", "reject"])("C1: repeated MAX replaces a pending quote despite stale %s", async outcome => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  pendingQuote = new Promise((yes, no) => { resolve = yes; reject = no; });
  await click("MAX"); await advance(450);
  expect(count("/api/selected-quote")).toBe(1);
  const originalBody = JSON.parse(calls.find(call => call.path === "/api/selected-quote")!.body!);
  await click("MAX");
  pendingQuote = undefined;
  await act(async () => {
    if (outcome === "reject") reject(new Error("Obsolete MAX quote"));
    else resolve(Response.json({ ...state, ...originalBody, requested: "1000000", liquidity: "999", expiresAt: Date.now() + 75000 }));
  });
  await advance(449); expect(count("/api/selected-quote")).toBe(1);
  await advance(1); expect(count("/api/selected-quote")).toBe(2);
  expect(button("Add liquidity").disabled).toBe(false);
  expect(container.querySelector<HTMLInputElement>("#amount")?.value).toBe("1");
  expect(container.textContent).not.toContain("Obsolete MAX quote");
  await advance(1000); expect(count("/api/selected-quote")).toBe(2);
  expect(count("/api/selected-prepare")).toBe(0);
  snapshot("repeated MAX recovered");
});
afterEach(async context => {
  await act(async () => root.unmount());
  expect(connection.signTransaction).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  expect(calls.filter(c => /broadcast/.test(c.path))).toHaveLength(0);
  // eslint-disable-next-line no-console -- Raw actual-caller preservation ledger.
  console.log("SELECTED_CALLER_LEDGER " + JSON.stringify({ name: context.task.name, calls, views, writes: writes.mock.calls, sign: 0, send: 0 }));
  container.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it("real Add busy blocks compound, then healthy preview resumes after HTTP failure", async () => {
  await ready(); await click("Add liquidity"); expect(count("/api/selected-prepare")).toBe(1);
  expect(button("One-click compound").disabled).toBe(true); await act(async () => button("One-click compound").click());
  expect(count("/api/compound-prepare")).toBe(0); await advance(1000); expect(count("/api/selected-quote")).toBe(1);
  await act(async () => release(Response.json({ error: "Prepare rejected" }, { status: 400 })));
  await advance(450); expect(button("Add liquidity").disabled).toBe(false); expect(button("One-click compound").disabled).toBe(false);
  snapshot("released");
});
it("real compound busy blocks Add caller while preview remains readable, then releases", async () => {
  await ready(); await click("One-click compound"); expect(count("/api/compound-prepare")).toBe(1);
  expect(button("Another operation in progress…").disabled).toBe(true);
  await act(async () => button("Another operation in progress…").click()); expect(count("/api/selected-prepare")).toBe(0);
  expect(container.textContent).toContain("A compound or recovery operation is in progress.");
  await act(async () => release(Response.json({ error: "Compound prepare rejected" }, { status: 400 })));
  expect(button("Add liquidity").disabled).toBe(false); snapshot("released");
});
it.each(["jupiter_no_route", "upstream"])("real caller preserves %s presentation and recovery", async code => {
  quoteError = code; await click("MAX"); await advance(450); snapshot("error");
  const alert = container.querySelector("#deposit-view [role=alert]")!;
  if (code === "jupiter_no_route") {
    expect(alert.textContent).toContain("No route from USDC to POOL"); expect(alert.textContent).not.toContain("Recalculate");
    quoteError = "";
    // A real user changes tolerance to schedule a new quote.
    const input = container.querySelector<HTMLInputElement>("#tolerance")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0.5"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  } else { expect(alert.textContent).toContain("Original wire error"); quoteError = ""; await click("Recalculate"); }
  await advance(450); expect(button("Add liquidity").disabled).toBe(false); snapshot("healthy");
  expect(count("/api/selected-prepare")).toBe(0);
});

it("attempt: invalid retained history warns in actual caller without locking fresh Add", async () => {
  await act(async () => root.unmount());
  const key = `sofinance:selected-atomic:v2:${wallet}`;
  localStorage.setItem(key, "invalid retained record"); writes.mockClear();
  root = createRoot(container);
  await act(async () => root.render(<WalletConnectionContext.Provider value={connection}><SelectedApp initialView="deposit" /></WalletConnectionContext.Provider>));
  await advance(30); await advance(30); await advance(30);
  expect(container.textContent).toContain("starting again may add liquidity twice");
  await ready(); await click("View add liquidity transaction");
  await click("Add liquidity"); expect(count("/api/selected-prepare")).toBe(1);
  await act(async () => release(Response.json({error:"Preparation rejected"},{status:400})));
  expect(localStorage.getItem(key)).toBe("invalid retained record");
  expect(button("Add liquidity").disabled).toBe(false); snapshot("history retained after prepare failure");
});
