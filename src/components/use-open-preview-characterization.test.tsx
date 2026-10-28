// @vitest-environment happy-dom
import { act, Activity, createElement, StrictMode, Suspense, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { OPEN_QUOTE_TIMEOUT_MS, useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { parseTokenAmount } from "@sofinance/engine/amount";
import { openAttemptKey } from "@/lib/open-attempt";
import { JUPITER_BROWSER_ORIGIN, resetJupiterBrowserGate } from "@/lib/jupiter/browser-relay";
import { buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";

// Only external boundaries are mocked: the facade, attempt/helper and relay are real.
const boundary = vi.hoisted(() => ({ wallet: "", connected: true, sign: vi.fn(), connect: vi.fn(), growth: vi.fn(), once: vi.fn(), notify: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: boundary.wallet, connected: boundary.connected, signTransaction: boundary.sign, connect: boundary.connect }) }));
vi.mock("@/lib/analytics/client", () => ({ captureGrowthEvent: boundary.growth, captureGrowthEventOnce: boundary.once }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: boundary.notify }));

const payer = testKeypair(1), nft = testKeypair(2), wallet = payer.publicKey.toBase58();
const pair: OpenPositionPair = { poolAddress: testKeypair(42).publicKey.toBase58(), mintA: testKeypair(8).publicKey.toBase58(), mintB: testKeypair(9).publicKey.toBase58(), symbolA: "AAA", symbolB: "BBB", wrappedSymbol: "AAAx", plainSymbol: "AAA", feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false };
const assets = [
  { kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true },
  { kind: "token", mint: NATIVE_SOL_MINT, decimals: 9, balance: "2000000000", eligible: true },
  { kind: "token", mint: USDC_MINT, decimals: 6, balance: "10000000", eligible: true },
  { kind: "token", mint: pair.mintA, decimals: 6, balance: "9000000", eligible: false, reason: "Synthetic unsupported asset" },
];
type Controller = ReturnType<typeof useOpenPositionController>;
type Body = { wallet: string; poolId: string; amount: string; inputMint: string; inputKind: "native" | "token"; rangePreset: string; minPrice: string; maxPrice: string; nftMint?: string; jupiterRelay?: { responses: Record<string, unknown> } };
let c: Controller, previous: Controller | undefined, root: Root, container: HTMLDivElement;
let currentPair: OpenPositionPair | null, hidden: boolean, suspend: boolean, mode: "visible" | "hidden", strict: boolean;
let ledger: unknown[], fetchMock: ReturnType<typeof vi.fn>, quoteReply: (body: Body) => Promise<Response>, relay: boolean;
let pending: Array<ReturnType<typeof deferred<Response>>>;
let signed: boolean;
const note = (event: string, ...data: unknown[]) => ledger.push([Date.now(), event, ...data]);
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
function quote(body: Body) {
  const decimals = body.inputMint === USDC_MINT ? 6 : 9;
  return { ...openSummaryFixture({ wallet, nftMint: nft.publicKey.toBase58(), blockhash: testKeypair(7).publicKey.toBase58() }).quote, wallet: body.wallet, poolId: body.poolId, inputMint: body.inputMint, inputKind: body.inputKind, inputDecimals: decimals, requested: parseTokenAmount(body.amount, decimals).toString(), expiresAt: Date.now() + 5000 };
}
function Suspender() { if (suspend) throw new Promise(() => {}); return null; }
function Harness() {
  const value = useOpenPositionController(currentPair);
  useEffect(() => {
    c = value;
    const projection = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "function"));
    const callbacks = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "function").map(([k, v]) => [k, previous ? v === previous[k as keyof Controller] : null]));
    note("commit", projection, callbacks, { quoteSame: previous ? value.quote === previous.quote : null, assetsSame: previous ? value.inputAssets === previous.inputAssets : null });
    previous = value;
  });
  return createElement(Suspender);
}
async function render() {
  const child = <Activity mode={mode}><Suspense fallback="suspended"><Harness /></Suspense></Activity>;
  await act(async () => root.render(strict ? createElement(StrictMode, null, child) : child));
}
async function advance(ms: number) { note("advance", ms); await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function command(name: string, fn: () => void) { note("command", name); await act(async () => fn()); }
async function mount() { await render(); await advance(1); await command("fixture selects native SOL", () => c.chooseAsset("native", NATIVE_SOL_MINT)); }
async function ready() { await mount(); await command("amount .002", () => c.changeAmount("0.002")); await advance(450); }
const calls = (path = "/api/open-quote") => fetchMock.mock.calls.filter(([url]) => url === path);
const bodyAt = (index: number, path?: string): Body => JSON.parse(String(calls(path).at(index)![1]!.body));
async function visible(value: boolean) { hidden = !value; note("visibility", value); await act(async () => document.dispatchEvent(new Event("visibilitychange"))); }
function holdQuote() { const wait = deferred<Response>(); pending.push(wait); quoteReply = () => wait.promise; return wait; }
const goodQuote = async (b: Body) => Response.json(quote(b));

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ledger = []; previous = undefined; pending = []; signed = false; hidden = false; suspend = false; mode = "visible"; strict = false; relay = false; currentPair = pair;
  boundary.wallet = wallet; boundary.connected = true; quoteReply = goodQuote; resetJupiterBrowserGate();
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  // Capture effect-owned timers with stable local IDs, callbacks, cancellation and order.
  let timerId = 0;
  const timers = new Map<number, number>();
  for (const key of ["setTimeout", "setInterval"] as const) {
    const original = window[key].bind(window);
    vi.spyOn(window, key).mockImplementation(((handler: () => void, delay?: number) => {
      const id = ++timerId; note(key, id, delay);
      const handle = original(() => { note("timer-fired", id); handler(); }, delay);
      timers.set(handle, id); return handle;
    }) as typeof window[typeof key]);
  }
  for (const key of ["clearTimeout", "clearInterval"] as const) {
    const original = window[key].bind(window);
    vi.spyOn(window, key).mockImplementation(id => { if (typeof id === "number" && timers.has(id)) note(key, timers.get(id)); original(id); });
  }
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((...args: Parameters<typeof document.addEventListener>) => { if (args[0] === "visibilitychange") note("listen", args[0]); add(...args); });
  vi.spyOn(document, "removeEventListener").mockImplementation((...args: Parameters<typeof document.removeEventListener>) => { if (args[0] === "visibilitychange") note("unlisten", args[0]); remove(...args); });
  const abort = AbortController.prototype.abort;
  vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (this: AbortController, reason) { note("abort", this.signal.aborted); abort.call(this, reason); });
  const storage = window.localStorage; storage.clear(); storage.setItem("sofiJupiterRelay", "off");
  vi.spyOn(window, "localStorage", "get").mockReturnValue(new Proxy(storage, { get(target, key) {
    if (key === "getItem") return (k: string) => { const v = target.getItem(k); note("storage-read", k, v); return v; };
    if (key === "setItem") return (k: string, v: string) => { note("storage-write", k, v); target.setItem(k, v); };
    if (key === "removeItem") return (k: string) => { note("storage-remove", k); target.removeItem(k); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } }));
  for (const [name, mock] of [["growth", boundary.growth], ["growth-once", boundary.once], ["notify", boundary.notify]] as const) mock.mockReset().mockImplementation((...args) => note(name, ...args));
  boundary.sign.mockReset().mockImplementation(async () => { signed = true; note("sign"); throw new Error("Synthetic wallet refusal"); });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    note("fetch", url, { method: init?.method ?? "GET", body: init?.body ?? null, cache: init?.cache, aborted: init?.signal?.aborted ?? null });
    init?.signal?.addEventListener("abort", () => note("fetch-abort", url), { once: true });
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    if (url.startsWith("/api/wallet?")) return Response.json({ assets });
    if (url.startsWith(JUPITER_BROWSER_ORIGIN + "/")) return Response.json({ inAmount: "2000000", outAmount: "777", routePlan: [] });
    if (url === "/api/open-quote" || url === "/api/open-prepare") {
      if (relay && !body.jupiterRelay?.responses["preview-quote"]) return Response.json({ code: "jupiter_relay_needed", needs: [{ id: "preview-quote", method: "GET", url: `/swap/v1/quote?inputMint=${NATIVE_SOL_MINT}&outputMint=${USDC_MINT}&amount=2000000` }] }, { status: 409 });
      if (url === "/api/open-quote") return quoteReply(body);
      const mint = body.nftMint ? new PublicKey(body.nftMint) : nft.publicKey;
      const tx = buildTransaction({ payer, extraSigners: [{ publicKey: mint, secretKey: new Uint8Array(64) } as typeof nft], signWith: [] });
      const summary = openSummaryFixture({ wallet, nftMint: mint.toBase58(), blockhash: tx.message.recentBlockhash });
      return Response.json({ unsignedTransaction: toBase64(tx), permit: "synthetic", summary: { ...summary, poolId: pair.poolAddress, quote: { ...quote(body), expiresAt: Date.now() + 10000, liquidity: "888" } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async context => {
  try {
  await act(async () => root.unmount());
  await act(async () => { for (const p of pending) p.reject(new Error("Owned teardown")); });
  const count = calls().length; await advance(Math.max(31_000, OPEN_QUOTE_TIMEOUT_MS + 1_000)); expect(calls()).toHaveLength(count);
  note("cleanup", { timers: vi.getTimerCount(), sign: boundary.sign.mock.calls.length, prepare: calls("/api/open-prepare").length, broadcast: calls("/api/open-broadcast").length });
  expect(vi.getTimerCount()).toBe(0);
  if (!signed) { expect(calls("/api/open-prepare")).toHaveLength(0); expect(boundary.sign).not.toHaveBeenCalled(); }
  expect(calls("/api/open-broadcast")).toHaveLength(0);
  expect(ledger.filter(x => Array.isArray(x) && x[1] === "storage-write" && String(x[2]).startsWith("sofinance:open"))).toEqual([]);
  } finally {
  // eslint-disable-next-line no-console -- Complete raw baseline/extracted/overlay evidence, never goldens.
  console.log("OPEN_PREVIEW_LEDGER " + JSON.stringify({ name: context.task.name, ledger }));
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});

describe("accepted Open preview characterization", () => {
  it.each([false, true])("debounces 449/450ms and polls on original relay=%s interval", async enabled => {
    if (enabled) window.localStorage.setItem("sofiJupiterRelay", "on");
    await mount(); await command("amount", () => c.changeAmount("0.002"));
    await advance(449); expect(calls()).toHaveLength(0); await advance(1); expect(calls()).toHaveLength(1);
    expect(c.actionDisabled).toBe(false); const interval = enabled ? 15000 : 3000;
    await advance(interval - 1); expect(calls()).toHaveLength(1); await advance(1); expect(calls()).toHaveLength(2);
  });
  it("cancels superseded debounce and maintains clock then discovery then reader effect order", async () => {
    await mount(); await command("first", () => c.changeAmount("0.001")); await advance(449);
    await command("replacement", () => c.changeAmount("0.002")); await advance(449); expect(calls()).toHaveLength(0);
    await advance(1); expect(calls()).toHaveLength(1); expect(bodyAt(0).amount).toBe("0.002");
    const timers = ledger.filter(x => Array.isArray(x) && (x[1] === "setTimeout" || x[1] === "setInterval")) as unknown[][];
    expect(timers.findIndex(x => x[3] === 1000)).toBeLessThan(timers.findIndex(x => x[3] === 450));
    expect(timers.findIndex(x => x[3] === 0)).toBeLessThan(timers.findIndex(x => x[3] === 450));
  });
  it("pauses errors for 30s, skips hidden polling, and recovers on visibility", async () => {
    quoteReply = async () => Response.json({ error: "Synthetic quota" }, { status: 429 }); await ready();
    expect(c.quoteError).toBe("Synthetic quota"); quoteReply = goodQuote;
    await advance(29999); expect(calls()).toHaveLength(1); await advance(1); expect(calls()).toHaveLength(2);
    await visible(false); await advance(6000); expect(calls()).toHaveLength(2);
    await visible(true); expect(calls()).toHaveLength(3); expect(c.quoteError).toBe(""); expect(c.actionDisabled).toBe(false);
  });
  it("explicit refresh bypasses failure pause at original debounce and visibility respects pause", async () => {
    quoteReply = async () => { throw new Error("Synthetic offline"); }; await ready();
    await visible(false); await visible(true); expect(calls()).toHaveLength(1);
    quoteReply = goodQuote; await command("refresh", () => c.refreshQuote()); await advance(449); expect(calls()).toHaveLength(1);
    await advance(1); expect(calls()).toHaveLength(2); expect(c.quoteError).toBe("");
  });
  it.each(["success", "error"])("ignores stale %s and finally while replacement is still loading", async result => {
    await mount(); const old = holdQuote(); await command("first", () => c.changeAmount("0.001")); await advance(450);
    const next = holdQuote(); await command("second", () => c.changeAmount("0.002")); await advance(450);
    const oldBody = bodyAt(0), nextBody = bodyAt(1);
    await act(async () => { if (result === "success") old.resolve(Response.json(quote(oldBody))); else old.reject(new Error("stale error")); });
    expect(c.quoteLoading).toBe(true); expect(c.quote).toBeNull(); expect(c.quoteError).toBe("");
    await act(async () => next.resolve(Response.json(quote(nextBody)))); expect(c.quote?.requested).toBe("2000000"); expect(c.quoteLoading).toBe(false);
  });
  it("synchronously rejects a same-value response and starts a replacement after debounce", async () => {
    await mount(); const old = holdQuote(); await command("first", () => c.changeAmount("0.002")); await advance(450);
    await act(async () => { c.changeAmount("0.002"); old.resolve(Response.json(quote(bodyAt(0)))); });
    expect(c.quote).toBeNull(); expect(c.quoteLoading).toBe(false);
    quoteReply = goodQuote; await advance(449); expect(calls()).toHaveLength(1);
    await advance(1); expect(calls()).toHaveLength(2); expect(c.quote?.requested).toBe("2000000");
  });
  it("restarts once for batched amount ABA without explicit refresh", async () => {
    await ready(); await command("batched ABA", () => { c.changeAmount("0.003"); c.changeAmount("0.002"); });
    expect(c.quote).toBeNull(); await advance(449); expect(calls()).toHaveLength(1);
    await advance(1); expect(calls()).toHaveLength(2); expect(bodyAt(1).amount).toBe("0.002");
    expect(c.quote?.requested).toBe("2000000");
  });
  it.each(["amount", "asset", "preset", "min", "max", "MAX"] as const)("same-value %s restarts once and fences old pending success/error/finally", async kind => {
    await ready();
    if (kind === "min" || kind === "max") {
      await command("custom range", () => { c.choosePreset("custom"); c.setMinPrice("1"); c.setMaxPrice("2"); });
      await advance(450);
    }
    if (kind === "MAX") { await command("first MAX", () => c.fillMax()); await advance(450); }
    const old = holdQuote(); await advance(3000); const oldBody = bodyAt(-1);
    const count = calls().length;
    const repeat = () => {
      if (kind === "amount") c.changeAmount(c.amount);
      else if (kind === "asset") c.chooseAsset("native", NATIVE_SOL_MINT);
      else if (kind === "preset") c.choosePreset(c.rangePreset);
      else if (kind === "min") c.setMinPrice("1");
      else if (kind === "max") c.setMaxPrice("2");
      else c.fillMax();
    };
    await command("repeat twice in same batch", () => { repeat(); repeat(); });
    const next = holdQuote(); await advance(449); expect(calls()).toHaveLength(count);
    await advance(1); expect(calls()).toHaveLength(count + 1); expect(c.quoteLoading).toBe(true);
    await act(async () => {
      if (kind === "amount" || kind === "preset" || kind === "min") old.resolve(Response.json({ ...quote(oldBody), liquidity: "stale" }));
      else old.reject(new Error("old refresh failed"));
    });
    expect(c.quote).toBeNull(); expect(c.quoteError).toBe(""); expect(c.quoteLoading).toBe(true);
    await act(async () => next.resolve(Response.json(quote(bodyAt(-1)))));
    expect(c.quoteLoading).toBe(false); expect(c.quote?.liquidity).not.toBe("stale"); expect(c.actionDisabled).toBe(false);
    quoteReply = goodQuote; await advance(2999); expect(calls()).toHaveLength(count + 1);
    await advance(1); expect(calls()).toHaveLength(count + 2);
  });
  it("retains request fields for kind, asset, preset, custom min/max and fillMax", async () => {
    await ready(); await command("token SOL", () => c.chooseAsset("token", NATIVE_SOL_MINT)); await advance(450);
    await command("USDC", () => c.chooseAsset("token", USDC_MINT)); await advance(450);
    await command("custom", () => c.choosePreset("custom")); expect(c.quoteError).toContain("custom min and max");
    await command("min", () => c.setMinPrice("1")); await advance(450); const count = calls().length;
    await command("max", () => c.setMaxPrice("2")); await advance(450); expect(calls()).toHaveLength(count + 1);
    await command("max amount", () => c.fillMax()); await advance(450);
    const b = bodyAt(-1); expect(b).toMatchObject({ inputKind: "token", inputMint: USDC_MINT, amount: "10", rangePreset: "custom", minPrice: "1", maxPrice: "2" });
  });
  it("blocks unsupported assets and parse errors with original priority", async () => {
    await ready(); await command("unsupported", () => c.chooseAsset("token", pair.mintA)); await advance(450);
    expect(c.actionBlockedReason).toBe("Synthetic unsupported asset"); expect(c.quoteError).toBe("Enter a valid amount");
    await command("native", () => c.chooseAsset("native", NATIVE_SOL_MINT)); await command("invalid", () => c.changeAmount("oops")); await advance(450);
    expect(c.actionBlockedReason).toBe("Enter a valid amount"); expect(calls()).toHaveLength(1);
    await command("valid", () => c.changeAmount("0.002")); await advance(450); expect(c.actionDisabled).toBe(false);
  });
  it("rejects requested mismatch then recovers with explicit refresh", async () => {
    quoteReply = async b => Response.json({ ...quote(b), requested: "999" }); await ready(); expect(c.quoteError).toContain("input mismatch");
    quoteReply = goodQuote; await command("refresh", () => c.refreshQuote()); await advance(450); expect(c.actionDisabled).toBe(false);
  });
  it("keeps stale quote expiry on the single facade clock without hidden refresh", async () => {
    await ready(); await visible(false); await advance(6000); expect(c.fresh).toBe(false); expect(c.actionBlockedReason).toContain("expired");
    await visible(true); expect(c.fresh).toBe(true); expect(c.actionDisabled).toBe(false);
  });
  it("does not overlap polling or refresh an in-flight read", async () => {
    await mount(); const wait = holdQuote(); await command("amount", () => c.changeAmount("0.002")); await advance(450);
    await advance(9000); await visible(true); await command("refresh blocked", () => c.refreshQuote()); expect(calls()).toHaveLength(1);
    await act(async () => wait.resolve(Response.json(quote(bodyAt(0))))); expect(c.quoteLoading).toBe(false);
  });
  it("fences committed wallet and pair changes with healthy return to original identity", async () => {
    await ready(); const wait = holdQuote(); await advance(3000);
    boundary.wallet = testKeypair(3).publicKey.toBase58(); currentPair = { ...pair, poolAddress: pair.mintA }; await render(); await advance(1);
    quoteReply = goodQuote; await advance(450); const current = c.quote;
    await act(async () => wait.resolve(Response.json(quote(bodyAt(1))))); expect(c.quote).toBe(current);
    boundary.wallet = wallet; currentPair = pair; await render(); await advance(1); await advance(450); expect(c.quote?.poolId).toBe(pair.poolAddress);
  });
  it("object churn restarts discovery and reader while stable rerender preserves cadence", async () => {
    await ready(); await render(); await advance(449); expect(calls()).toHaveLength(1);
    currentPair = { ...pair }; await render(); await advance(1); await advance(449); expect(calls()).toHaveLength(1);
    await advance(1); expect(calls()).toHaveLength(2);
  });
  it.each(["strict", "activity", "suspense", "unmount"])("preserves %s lifecycle cleanup and recovery", async lifecycle => {
    strict = lifecycle === "strict"; await ready(); const wait = holdQuote(); await advance(3000);
    const body = bodyAt(-1);
    if (lifecycle === "activity") { mode = "hidden"; await render(); }
    if (lifecycle === "suspense") { suspend = true; await render(); }
    if (lifecycle === "unmount" || lifecycle === "strict") { await act(async () => root.unmount()); root = createRoot(container); }
    await act(async () => wait.resolve(Response.json(quote(body)))); quoteReply = goodQuote;
    if (lifecycle === "activity") { mode = "visible"; await render(); await advance(1); await advance(450); }
    else if (lifecycle === "suspense") { suspend = false; await render(); await advance(3000); }
    else { await ready(); }
    expect(c.quote).not.toBeNull(); expect(c.actionDisabled).toBe(false);
  });
  it("retains wallet-level invalid-history lock and error priority without quote work", async () => {
    window.localStorage.setItem(openAttemptKey(wallet), "broken"); note("fixture-seeded", ledger.pop()); await mount(); await command("amount", () => c.changeAmount("oops")); await advance(450);
    expect(c.busy).toBe(true); expect(c.error).toContain("cannot be verified"); expect(c.actionBlockedReason).toContain("original open-position");
    await command("blocked commands", () => { c.refreshQuote(); c.createAnother(); }); expect(calls()).toHaveLength(0);
  });
  it("shares the real relay cache with prepare and adopts its quote at the wallet boundary", async () => {
    relay = true; window.localStorage.setItem("sofiJupiterRelay", "on"); await ready();
    const providerCalls = () => fetchMock.mock.calls.filter(([url]) => url.startsWith(JUPITER_BROWSER_ORIGIN + "/"));
    expect(providerCalls()).toHaveLength(1); const before = c.quote;
    await act(async () => c.signAndSend()); expect(c.quote).not.toBe(before); expect(c.quote?.liquidity).toBe("888");
    expect(c.error).toBe("Synthetic wallet refusal"); expect(providerCalls()).toHaveLength(1); expect(calls("/api/open-prepare")).toHaveLength(1);
    expect(bodyAt(0, "/api/open-prepare").jupiterRelay!.responses["preview-quote"]).toBeTruthy();
    expect(c.quoteLoading).toBe(false); await advance(450); expect(c.actionDisabled).toBe(false);
  });
});
