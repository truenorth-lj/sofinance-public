// @vitest-environment happy-dom
import { act, Activity, createElement, StrictMode, Suspense, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { OPEN_PREPARE_TIMEOUT_MS, useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { openAttemptKey } from "@/lib/open-attempt";
import { resetJupiterBrowserGate } from "@/lib/jupiter/browser-relay";
import { buildTransaction, openSummaryFixture, phantomRewriteTransaction, tamperTransferLamports, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";

// Real facade, preview, attempt, storage helpers and relay; only external boundaries are synthetic.
const boundary = vi.hoisted(() => ({ wallet: "" as string | undefined, connected: true, sign: vi.fn(), connect: vi.fn(), growth: vi.fn(), once: vi.fn(), notify: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: boundary.wallet, connected: boundary.connected, signTransaction: boundary.sign, connect: boundary.connect }) }));
vi.mock("@/lib/analytics/client", () => ({ captureGrowthEvent: boundary.growth, captureGrowthEventOnce: boundary.once }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: boundary.notify }));
vi.mock("@/lib/analytics/attribution", () => ({ getStoredAttribution: () => ({ ref: "synthetic-source" }) }));
const payer = testKeypair(1), nft = testKeypair(2), wallet = payer.publicKey.toBase58();
const pair: OpenPositionPair = { poolAddress: testKeypair(42).publicKey.toBase58(), mintA: testKeypair(8).publicKey.toBase58(), mintB: testKeypair(9).publicKey.toBase58(), symbolA: "AAA", symbolB: "BBB", wrappedSymbol: "AAAx", plainSymbol: "AAA", feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false };
type Controller = ReturnType<typeof useOpenPositionController>;
let c: Controller, previous: Controller | undefined, root: Root, container: HTMLDivElement;
let currentPair: OpenPositionPair | null, mode: "visible" | "hidden", suspend: boolean, strict: boolean;
let layoutCommand: (() => void) | undefined;
let controllerLayoutCommand: ((value: Controller) => void) | undefined;
function LayoutInvoker() { useLayoutEffect(() => { layoutCommand?.(); }); return null; }
let readUnavailable = false;
let ledger: unknown[][], fetchMock: ReturnType<typeof vi.fn>, storage: Storage;
let prepareReply: () => Promise<Response>, broadcastReply: (init: RequestInit) => Promise<Response>;
let preparedValue: ReturnType<typeof prepared>, chainStatus: string, writeMode: "ok" | "throw" | "drop", scanError: boolean;
let waits: Array<ReturnType<typeof deferred<VersionedTransaction>>>;
const note = (event: string, ...data: unknown[]) => ledger.push([Date.now(), event, ...data]);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function prepared(nftMint = nft.publicKey, blockhash?: string) {
  const tx = buildTransaction({ payer, extraSigners: [{ publicKey: nftMint, secretKey: new Uint8Array(64) } as typeof nft], signWith: [], ...(blockhash ? { blockhash } : {}) });
  const summary = openSummaryFixture({ wallet, nftMint: nftMint.toBase58(), blockhash: tx.message.recentBlockhash });
  return { unsignedTransaction: toBase64(tx), permit: "synthetic-permit", summary: { ...summary, poolId: pair.poolAddress,
    quote: { ...summary.quote, poolId: pair.poolAddress, inputMint: NATIVE_SOL_MINT, inputKind: "native" as "native" | "token", inputDecimals: 9 } } };
}
function Suspender() { if (suspend) throw new Promise(() => {}); return null; }
function Harness() {
  const value = useOpenPositionController(currentPair);
  useLayoutEffect(() => { controllerLayoutCommand?.(value); });
  useEffect(() => {
    c = value;
    const projection = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "function"));
    const callbacks = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "function").map(([k, v]) => [k, previous ? v === previous[k as keyof Controller] : null]));
    note("commit", projection, callbacks, { quoteSame: previous ? value.quote === previous.quote : null, assetsSame: previous ? value.inputAssets === previous.inputAssets : null }); previous = value;
  });
  return createElement(Suspender);
}
async function render() {
  const child = <><Activity mode={mode}><Suspense fallback="suspended"><Harness /></Suspense></Activity><LayoutInvoker /></>;
  await act(async () => root.render(strict ? createElement(StrictMode, null, child) : child));
}
async function advance(ms: number) { note("advance", ms); await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function command(name: string, fn: () => void) { note("command", name); await act(async () => fn()); }
async function ready() { await render(); await advance(1); await command("amount", () => c.changeAmount("0.002")); await advance(450); expect(c.actionDisabled).toBe(false); }
async function send() { note("command", "send"); await act(async () => c.signAndSend()); }
const calls = (url: string) => fetchMock.mock.calls.filter(([path]) => path === url);
function signed(tx: VersionedTransaction) { const result = VersionedTransaction.deserialize(tx.serialize()); result.sign([payer]); return result; }
function holdSign() { const wait = deferred<VersionedTransaction>(); waits.push(wait); let tx!: VersionedTransaction;
  boundary.sign.mockImplementation((value: VersionedTransaction) => { note("sign-input", toBase64(value)); tx = signed(value); return wait.promise; });
  return { release: () => { note("sign-output", toBase64(tx)); wait.resolve(tx); } };
}
function expectNoSend() { expect(calls("/api/open-broadcast")).toHaveLength(0); expect(storage.getItem(openAttemptKey(wallet))).toBeNull(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  layoutCommand = undefined; controllerLayoutCommand = undefined; readUnavailable = false; ledger = []; previous = undefined; currentPair = pair; mode = "visible"; suspend = false; strict = false; waits = [];
  boundary.wallet = wallet; boundary.connected = true; chainStatus = "pending"; writeMode = "ok"; scanError = false;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  resetJupiterBrowserGate(); preparedValue = prepared();
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
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { note("deadline", ms); return timeout(ms); });
  storage = window.localStorage; storage.clear(); storage.setItem("sofiJupiterRelay", "off");
  vi.spyOn(window, "localStorage", "get").mockReturnValue(new Proxy(storage, { get(target, key) {
    if (key === "getItem") return (k: string) => { if (readUnavailable && k === openAttemptKey(wallet)) throw new Error("history unavailable"); const v = target.getItem(k); note("storage-read", k, v); return v; };
    if (key === "setItem") return (k: string, v: string) => { note("storage-write", k, v, writeMode); if (writeMode === "throw") throw new Error("storage denied"); if (writeMode !== "drop") target.setItem(k, v); };
    if (key === "removeItem") return (k: string) => { note("storage-remove", k); target.removeItem(k); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } }));
  for (const [name, mock] of [["growth", boundary.growth], ["growth-once", boundary.once], ["notify", boundary.notify]] as const) mock.mockReset().mockImplementation((...args) => note(name, ...args));
  boundary.sign.mockReset().mockImplementation(async (tx: VersionedTransaction) => { note("sign-input", toBase64(tx)); const value = signed(tx); note("sign-output", toBase64(value)); return value; });
  prepareReply = async () => Response.json(preparedValue);
  broadcastReply = async init => { const body = JSON.parse(String(init.body)); const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64")); return Response.json({ signature: bs58.encode(tx.signatures[0]!), beamLabel: "Beam landed" }); };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    note("fetch", url, { method: init?.method ?? "GET", body: init?.body ?? null, headers: init?.headers ?? null, cache: init?.cache, aborted: init?.signal?.aborted ?? null });
    init?.signal?.addEventListener("abort", () => note("fetch-abort", url), { once: true });
    const body = JSON.parse(String(init?.body ?? "{}"));
    let response: Response;
    if (url.startsWith("/api/wallet?")) response = scanError ? Response.json({ error: "Synthetic scan failure" }, { status: 500 }) : Response.json({ assets: [{ kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true }] });
    else if (url === "/api/open-quote") response = Response.json(preparedValue.summary.quote);
    else if (url === "/api/open-prepare") {
      // The app now owns the mint key; the server prepares its requested public key unsigned.
      expect(typeof body.nftMint).toBe("string");
      const current = VersionedTransaction.deserialize(Buffer.from(preparedValue.unsignedTransaction, "base64"));
      const next = prepared(new PublicKey(body.nftMint), current.message.recentBlockhash);
      preparedValue = { ...preparedValue, unsignedTransaction: next.unsignedTransaction,
        summary: { ...preparedValue.summary, nftMint: body.nftMint } };
      response = await prepareReply();
    }
    else if (url === "/api/open-broadcast") response = await broadcastReply(init!);
    else if (url === "/api/open-status") response = Response.json({ signature: body.attempt.signature, status: chainStatus });
    else throw new Error(`Unexpected request: ${url}`);
    const json = response.json.bind(response); response.json = async () => { const result = await json(); note("json", url, result); return result; }; return response;
  });
  vi.stubGlobal("fetch", fetchMock); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async context => {
  try {
    await act(async () => root.unmount());
    await act(async () => { for (const wait of waits) wait.reject(new Error("Owned teardown")); });
    await advance(OPEN_PREPARE_TIMEOUT_MS + 1_000); note("cleanup", { timers: vi.getTimerCount(), signs: boundary.sign.mock.calls.length, prepares: calls("/api/open-prepare").length, broadcasts: calls("/api/open-broadcast").length,
      storage: Object.fromEntries(Array.from({ length: storage.length }, (_, i) => { const key = storage.key(i)!; return [key, storage.getItem(key)]; })) });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    // eslint-disable-next-line no-console -- Full raw accepted-base/overlay/extracted observable evidence.
    console.log("OPEN_OWNERSHIP_LEDGER " + JSON.stringify({ name: context.task.name, ledger }));
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});

// Fixture/instrumentation adapted from the original PR174 characterization. Assertions below
// independently specify ownership behavior; baseline RED is preserved outside the repository.
function nextTransaction() {
  const tx = buildTransaction({ payer, extraSigners: [nft], signWith: [nft], blockhash: pair.mintA });
  preparedValue.unsignedTransaction = toBase64(tx); preparedValue.summary.blockhash = tx.message.recentBlockhash;
}
const invalidations = ["amount", "asset", "preset", "min", "max", "MAX", "refresh", "another"] as const;
function invalidate(kind: typeof invalidations[number]) {
  if (kind === "amount") c.changeAmount(c.amount);
  if (kind === "asset") c.chooseAsset(c.inputKind, c.inputMint!);
  if (kind === "preset") c.choosePreset(c.rangePreset);
  if (kind === "min") c.setMinPrice(c.minPrice);
  if (kind === "max") c.setMaxPrice(c.maxPrice);
  if (kind === "MAX") c.fillMax();
  if (kind === "refresh") c.refreshQuote();
  if (kind === "another") c.createAnother();
}
async function change(kind: string) {
  if (kind === "same-value") await command(kind, () => c.changeAmount(c.amount));
  if (kind === "batched-ABA") await command(kind, () => { c.changeAmount("0.004"); c.changeAmount("0.002"); });
  if (kind === "separate-ABA") { await command("B", () => c.changeAmount("0.004")); await command("A", () => c.changeAmount("0.002")); }
  if (kind === "wallet-ABA") { boundary.wallet = pair.mintA; await render(); boundary.wallet = wallet; await render(); }
  if (kind === "pool-ABA") { currentPair = { ...pair, poolAddress: pair.mintA }; await render(); currentPair = pair; await render(); }
  if (kind === "connected-ABA") { boundary.connected = false; await render(); boundary.connected = true; await render(); }
  if (kind === "activity") { mode = "hidden"; await render(); mode = "visible"; await render(); }
  if (kind === "suspense") { suspend = true; await render(); suspend = false; await render(); }
  if (kind === "unmount") { await act(async () => root.unmount()); root = createRoot(container); }
}
describe("Open submission ownership", () => {
  it.each(["activity", "suspense"])("pre-reconnect ready callback cannot borrow the new %s lifetime", async kind => {
    strict = true; await ready(); const old = c.signAndSend;
    await change(kind); await advance(1);
    await act(async () => old());
    expect(calls("/api/open-prepare")).toHaveLength(0); expect(boundary.sign).not.toHaveBeenCalled(); expectNoSend();
    await advance(450); await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it.each(["activity", "suspense"])("reveal layout cannot revive a saved %s callback before passive revalidation", async kind => {
    await ready(); const old = c.signAndSend;
    if (kind === "activity") mode = "hidden"; else suspend = true;
    await render();
    let sending: Promise<void> | undefined;
    layoutCommand = () => { layoutCommand = undefined; sending = old(); };
    if (kind === "activity") mode = "visible"; else suspend = false;
    await render(); await act(async () => { await sending; });
    expect(calls("/api/open-prepare")).toHaveLength(0); expect(boundary.sign).not.toHaveBeenCalled(); expectNoSend();
    await advance(451); await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it("latest Activity layout callbacks wait for passive history revalidation", async () => {
    strict = true; await ready(); mode = "hidden"; await render();
    const commands: Promise<void>[] = [];
    controllerLayoutCommand = value => { commands.push(value.signAndSend()); };
    mode = "visible"; await render(); await act(async () => { await Promise.all(commands); });
    expect(commands.length).toBeGreaterThan(0);
    expect(calls("/api/open-prepare")).toHaveLength(0); expectNoSend();
    controllerLayoutCommand = undefined;
    await advance(451); await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it.each(["activity", "suspense"])("multiple %s reconnects revoke every older ready generation", async kind => {
    strict = true; await ready(); const callbacks = [c.signAndSend];
    for (let i = 0; i < 3; i += 1) {
      await change(kind); await advance(451);
      await act(async () => { for (const old of callbacks) await old(); });
      expect(calls("/api/open-prepare")).toHaveLength(0);
      callbacks.push(c.signAndSend);
    }
    await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it.each(["activity", "suspense"])("fresh %s generation preserves Phantom wallet-first signing", async kind => {
    await ready(); const old = c.signAndSend;
    await change(kind); await advance(451);
    boundary.sign.mockImplementation(async (tx: VersionedTransaction) => {
      expect(tx.signatures.every(slot => slot.every(byte => byte === 0))).toBe(true);
      return signed(phantomRewriteTransaction(tx));
    });
    await act(async () => old()); expect(calls("/api/open-prepare")).toHaveLength(0);
    await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
    const body = JSON.parse(String(calls("/api/open-broadcast")[0]![1].body));
    const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    expect(tx.signatures.every(slot => slot.some(byte => byte !== 0))).toBe(true);
    expect(body.unsignedTransaction).toBe(preparedValue.unsignedTransaction);
    expect(c.signature).toBe(bs58.encode(tx.signatures[0]!));
  });
  it("new generation still rejects wallet changes to core transfer instructions", async () => {
    await ready(); await change("suspense"); await advance(1);
    boundary.sign.mockImplementation(async (tx: VersionedTransaction) => signed(tamperTransferLamports(tx, 123_456)));
    await send(); expect(calls("/api/open-prepare")).toHaveLength(1);
    expect(boundary.sign).toHaveBeenCalledTimes(1); expectNoSend(); expect(c.error).not.toBe("");
  });
  it.each(["accepted", "unknown", "mismatch"])("retained ready command cannot replace its unresolved %s receipt", async outcome => {
    await ready(); const retained = c.signAndSend;
    if (outcome === "unknown") broadcastReply = async () => { throw new Error("unknown send"); };
    if (outcome === "mismatch") broadcastReply = async () => Response.json({ signature: "mismatch" });
    await send(); const first = storage.getItem(openAttemptKey(wallet)); expect(first).not.toBeNull(); expect(c.busy).toBe(true);
    nextTransaction(); await act(async () => retained());
    expect(calls("/api/open-prepare")).toHaveLength(1); expect(boundary.sign).toHaveBeenCalledTimes(1);
    expect(calls("/api/open-broadcast")).toHaveLength(1); expect(storage.getItem(openAttemptKey(wallet))).toBe(first);
    expect(storage.getItem(openAttemptKey(wallet) + ":history:" + JSON.parse(first!).signature)).toBeNull();
  });
  it.each(invalidations)("same-value %s invalidates a retained ready callback synchronously before render", async kind => {
    await ready();
    if (kind === "MAX") { await command("set MAX", () => c.fillMax()); preparedValue.summary.quote.requested = "1000000000"; await advance(450); }
    const retained = c.signAndSend;
    await act(async () => { invalidate(kind); await retained(); });
    expect(calls("/api/open-prepare")).toHaveLength(0); expect(boundary.sign).not.toHaveBeenCalled(); expectNoSend();
    await advance(450); await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  for (const phase of ["prepare", "json", "wallet"] as const) {
    it.each(["same-value", "batched-ABA", "separate-ABA", "wallet-ABA", "pool-ABA", "connected-ABA", "activity", "suspense", "unmount"])(`${phase} reply remains revoked after %s`, async kind => {
      await ready(); const wait = deferred<Response>(), json = deferred<ReturnType<typeof prepared>>();
      const normalPrepare = prepareReply, normalSign = boundary.sign.getMockImplementation()!;
      const signing = phase === "wallet" ? holdSign() : null;
      if (phase === "prepare") prepareReply = () => wait.promise;
      if (phase === "json") prepareReply = async () => { const response = Response.json({}); response.json = () => json.promise; return response; };
      let sending!: Promise<void>; await command("start", () => { sending = c.signAndSend(); });
      await change(kind);
      await act(async () => { if (phase === "prepare") wait.resolve(Response.json(preparedValue)); else if (phase === "json") json.resolve(preparedValue); else signing!.release(); await sending; });
      if (phase !== "wallet") expect(boundary.sign).not.toHaveBeenCalled();
      expectNoSend();
      // A revoked command does not permanently lock a healthy new operation.
      if (kind !== "unmount") {
        prepareReply = normalPrepare; boundary.sign.mockImplementation(normalSign); await advance(451);
        await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
      }
    });
  }
  it.each(["amount", "asset", "preset", "min", "max", "MAX"] as const)("wallet reply is revoked by same-value %s command", async kind => {
    await ready(); if (kind === "MAX") { await command("MAX", () => c.fillMax()); preparedValue.summary.quote.requested = "1000000000"; await advance(450); }
    const signing = holdSign(); let sending!: Promise<void>; await command("start", () => { sending = c.signAndSend(); });
    await command(kind, () => invalidate(kind)); await act(async () => { signing.release(); await sending; }); expectNoSend();
  });
  it.each(["confirmed", "failed", "expired", "unsent"])("healthy %s permits a distinct new attempt without a permanent ref lock", async terminal => {
    await ready(); const normal = broadcastReply;
    if (terminal === "unsent") broadcastReply = async () => Response.json({ error: "not sent", sent: false }, { status: 400 });
    await send(); const first = c.signature; expect(first).not.toBe("");
    if (terminal !== "unsent") { chainStatus = terminal; await advance(1); }
    expect(c.busy).toBe(false); await command("another", () => c.createAnother()); await advance(450);
    nextTransaction(); broadcastReply = normal; chainStatus = "pending"; await send();
    expect(calls("/api/open-broadcast")).toHaveLength(2); expect(c.signature).not.toBe(first); expect(c.busy).toBe(true);
  });
  for (const terminal of ["failed", "expired"] as const) {
    it.each([false, true])(`verified ${terminal} replaces an unknown-send error (retry=%s)`, async retry => {
      await ready();
      if (retry) {
        await send(); chainStatus = "failed"; await advance(1); await advance(450);
        nextTransaction(); chainStatus = "pending";
      }
      broadcastReply = async () => { throw new Error("Synthetic lost broadcast response"); };
      await send();
      const original = c.signature;
      const raw = storage.getItem(openAttemptKey(wallet)); expect(raw).not.toBeNull();
      expect(c.busy).toBe(true); expect(c.error).toContain("unconfirmed");
      chainStatus = terminal;
      await command("verify original", () => c.retryConfirmation());
      expect(c.signature).toBe(original); expect(c.busy).toBe(false);
      expect(c.error).toContain(terminal === "failed" ? "failed on-chain" : "expired");
      expect(c.error).not.toContain("unconfirmed");
      expect(calls("/api/open-broadcast")).toHaveLength(retry ? 2 : 1);
      expect(boundary.sign).toHaveBeenCalledTimes(retry ? 2 : 1);
    });
  }
  for (const terminal of ["failed", "expired"] as const) {
    it.each(["removed", "unavailable"])(`${terminal} retry exposes history rejection when its receipt is %s`, async condition => {
      await ready(); await send(); chainStatus = terminal; await advance(1); await advance(450);
      expect(c.busy).toBe(false); expect(c.actionDisabled).toBe(false);
      const terminalError = c.error;
      expect(terminalError).not.toBe("");
      const raw = storage.getItem(openAttemptKey(wallet)); expect(raw).not.toBeNull();
      if (condition === "removed") storage.removeItem(openAttemptKey(wallet));
      else readUnavailable = true;
      await send();
      expect(calls("/api/open-prepare")).toHaveLength(1);
      expect(boundary.sign).toHaveBeenCalledTimes(1);
      expect(calls("/api/open-broadcast")).toHaveLength(1);
      expect(storage.getItem(openAttemptKey(wallet))).toBe(condition === "removed" ? null : raw);
      expect(c.error).toContain("history changed");
      expect(c.error).not.toBe(terminalError);
      // Restoring the receipt and clearing the form error keeps terminal diagnostics available.
      readUnavailable = false; storage.setItem(openAttemptKey(wallet), raw!);
      await command("clear error", () => c.changeAmount(c.amount));
      expect(c.error).toBe(terminalError);
    });
    it(`${terminal} retry exposes the latest prepare failure`, async () => {
      await ready(); await send(); chainStatus = terminal; await advance(1); await advance(450);
      prepareReply = async () => Response.json({ error: "Synthetic retry prepare failure" }, { status: 500 });
      await send();
      expect(c.error).toBe("Synthetic retry prepare failure");
      expect(calls("/api/open-prepare")).toHaveLength(2);
      expect(boundary.sign).toHaveBeenCalledTimes(1);
      expect(calls("/api/open-broadcast")).toHaveLength(1);
    });
  }
  it.each(["invalid", "unavailable", "manual-review", "foreign-pool"])("retained callback respects current %s history", async kind => {
    await ready(); const retained = c.signAndSend;
    if (kind === "manual-review" || kind === "foreign-pool") { await send(); chainStatus = "manual-review"; await advance(1); if (kind === "foreign-pool") { currentPair = { ...pair, poolAddress: pair.mintA }; await render(); } }
    if (kind === "invalid") storage.setItem(openAttemptKey(wallet), "malformed");
    if (kind === "unavailable") readUnavailable = true;
    const before = calls("/api/open-prepare").length; await act(async () => retained());
    expect(calls("/api/open-prepare")).toHaveLength(before); expect(boundary.sign.mock.calls.length).toBe(kind === "manual-review" || kind === "foreign-pool" ? 1 : 0);
  });
  it("ordinary clock and same-pool metadata commits do not cancel an eligible in-flight command", async () => {
    strict = true; await ready(); const signing = holdSign(); let sending!: Promise<void>; await command("start", () => { sending = c.signAndSend(); });
    currentPair = { ...pair, symbolA: "renamed" }; await render(); await advance(1000);
    await act(async () => { signing.release(); await sending; }); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it("keeps the old operation lock until it settles and its finally cannot release a newer operation", async () => {
    await ready(); const first = deferred<Response>(), second = deferred<Response>(); prepareReply = () => first.promise;
    let old!: Promise<void>; await command("old", () => { old = c.signAndSend(); }); await change("suspense");
    await send(); expect(calls("/api/open-prepare")).toHaveLength(1);
    await act(async () => { first.resolve(Response.json(preparedValue)); await old; }); expectNoSend(); expect(boundary.sign).not.toHaveBeenCalled();
    await advance(450); prepareReply = () => second.promise; let newer!: Promise<void>; await command("new", () => { newer = c.signAndSend(); });
    await act(async () => old); expect(c.submitStage).toBe("preparing"); await send(); expect(calls("/api/open-prepare")).toHaveLength(2);
    await act(async () => { second.resolve(Response.json(preparedValue)); await newer; }); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it.each(["wallet-ABA", "pool-ABA", "connected-ABA"])("retained ready command stays revoked after committed %s", async kind => {
    await ready(); const retained = c.signAndSend; await change(kind); await act(async () => retained());
    expect(calls("/api/open-prepare")).toHaveLength(0); expect(boundary.sign).not.toHaveBeenCalled(); expectNoSend();
    await advance(451); await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it("a retained createAnother cannot dismiss an unresolved newer receipt", async () => {
    await ready(); const another = c.createAnother, retained = c.signAndSend;
    await send(); const first = storage.getItem(openAttemptKey(wallet)); await command("stale another", another);
    expect(c.busy).toBe(true); await act(async () => retained());
    expect(calls("/api/open-prepare")).toHaveLength(1); expect(storage.getItem(openAttemptKey(wallet))).toBe(first);
  });
  it("reconnecting Activity locks history before its loader settles", async () => {
    await ready(); const retained = c.signAndSend; mode = "hidden"; await render(); mode = "visible"; await render();
    await act(async () => retained()); expect(calls("/api/open-prepare")).toHaveLength(0);
    await advance(451); await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it.each(["same-value", "wallet-ABA", "pool-ABA", "activity", "suspense", "unmount"])("unknown broadcast after %s retains the original receipt", async kind => {
    await ready(); const reply = deferred<Response>(); broadcastReply = () => reply.promise;
    let sending!: Promise<void>; await command("start", () => { sending = c.signAndSend(); });
    const first = storage.getItem(openAttemptKey(wallet)); expect(first).not.toBeNull();
    await change(kind); await act(async () => { reply.reject(new Error("unknown after UI change")); await sending; });
    expect(calls("/api/open-broadcast")).toHaveLength(1); expect(storage.getItem(openAttemptKey(wallet))).toBe(first);
  });

});
