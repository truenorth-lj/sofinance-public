// @vitest-environment happy-dom
import { act, Activity, createElement, StrictMode, Suspense, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These suites drive the single-transaction open flow with wSOL token input (native
// SOL now opens in two steps; see sol-swap-step tests). The flag mock keeps SOL listed.
const solInputFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/feature-flags")>(),
  get SOL_INPUT_ENABLED() { return solInputFlag.enabled; },
}));
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { OPEN_PREPARE_TIMEOUT_MS, useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { openAttemptKey } from "@/lib/open-attempt";
import { resetJupiterBrowserGate } from "@/lib/jupiter/browser-relay";
import { buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";

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
let ledger: unknown[][], fetchMock: ReturnType<typeof vi.fn>, storage: Storage;
let prepareReply: () => Promise<Response>, broadcastReply: (init: RequestInit) => Promise<Response>;
let preparedValue: ReturnType<typeof prepared>, chainStatus: string, writeMode: "ok" | "throw" | "drop", scanError: boolean;
let waits: Array<ReturnType<typeof deferred<VersionedTransaction>>>;
const note = (event: string, ...data: unknown[]) => ledger.push([Date.now(), event, ...data]);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function prepared(nftMint = nft.publicKey, blockhash?: string) {
  const tx = buildTransaction({
    payer,
    extraSigners: [{ publicKey: nftMint, secretKey: new Uint8Array(64) } as typeof nft],
    signWith: [],
    ...(blockhash ? { blockhash } : {}),
  });
  const summary = openSummaryFixture({ wallet, nftMint: nftMint.toBase58(), blockhash: tx.message.recentBlockhash });
  return { unsignedTransaction: toBase64(tx), permit: "synthetic-permit", summary: { ...summary, poolId: pair.poolAddress,
    quote: { ...summary.quote, poolId: pair.poolAddress, inputMint: NATIVE_SOL_MINT, inputKind: "token" as "native" | "token", inputDecimals: 9 } } };
}
function Suspender() { if (suspend) throw new Promise(() => {}); return null; }
function Harness() {
  const value = useOpenPositionController(currentPair);
  useEffect(() => {
    c = value;
    const projection = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "function"));
    const callbacks = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "function").map(([k, v]) => [k, previous ? v === previous[k as keyof Controller] : null]));
    note("commit", projection, callbacks, { quoteSame: previous ? value.quote === previous.quote : null, assetsSame: previous ? value.inputAssets === previous.inputAssets : null }); previous = value;
  });
  return createElement(Suspender);
}
async function render() {
  const child = <Activity mode={mode}><Suspense fallback="suspended"><Harness /></Suspense></Activity>;
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
  ledger = []; previous = undefined; currentPair = pair; mode = "visible"; suspend = false; strict = false; waits = [];
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
    if (key === "getItem") return (k: string) => { const v = target.getItem(k); note("storage-read", k, v); return v; };
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
    if (url.startsWith("/api/wallet?")) response = scanError ? Response.json({ error: "Synthetic scan failure" }, { status: 500 }) : Response.json({ assets: [{ kind: "token", mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true }] });
    else if (url === "/api/open-quote") response = Response.json(preparedValue.summary.quote);
    else if (url === "/api/open-prepare") {
      if (typeof body.nftMint === "string") {
        try {
          const mint = new PublicKey(body.nftMint);
          const current = VersionedTransaction.deserialize(Buffer.from(preparedValue.unsignedTransaction, "base64"));
          const payerOk = current.message.staticAccountKeys[0]?.equals(payer.publicKey);
          const nftMismatch = preparedValue.summary.nftMint === pair.mintA;
          if (payerOk && !nftMismatch) {
            const next = prepared(mint, current.message.recentBlockhash);
            preparedValue = {
              unsignedTransaction: next.unsignedTransaction,
              permit: preparedValue.permit,
              summary: {
                ...preparedValue.summary,
                nftMint: mint.toBase58(),
                blockhash: preparedValue.summary.blockhash === current.message.recentBlockhash
                  ? next.summary.blockhash
                  : preparedValue.summary.blockhash,
              },
            };
          }
        } catch { /* Keep mutated bytes so mismatch cases still reject. */ }
      }
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
    console.log("OPEN_SUBMISSION_LEDGER " + JSON.stringify({ name: context.task.name, ledger }));
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});

describe("Open submission through real facade", () => {
  it.each([false, true])("orders durable readback before broadcast and acceptance before confirmation (StrictMode=%s)", async value => {
    strict = value; await ready(); await send();
    const body = JSON.parse(String(calls("/api/open-broadcast")[0]![1].body));
    const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    const original = VersionedTransaction.deserialize(Buffer.from(preparedValue.unsignedTransaction, "base64"));
    expect(tx.message.serialize()).toEqual(original.message.serialize()); expect(tx.signatures[1]?.some((byte: number) => byte !== 0)).toBe(true);
    const signature = bs58.encode(tx.signatures[0]!); expect(c.signature).toBe(signature);
    expect(body).toEqual({ signedTransaction: toBase64(tx), unsignedTransaction: preparedValue.unsignedTransaction, permit: preparedValue.permit, wallet, summary: preparedValue.summary, sourceRef: "synthetic-source" });
    const stored = JSON.parse(storage.getItem(openAttemptKey(wallet))!); expect(stored.signature).toBe(signature);
    const writeAt = ledger.findIndex(x => x[1] === "storage-write" && x[2] === openAttemptKey(wallet));
    const readAt = ledger.findIndex((x, i) => i > writeAt && x[1] === "storage-read" && x[2] === openAttemptKey(wallet) && x[3] === JSON.stringify(stored));
    const sendAt = ledger.findIndex(x => x[1] === "fetch" && x[2] === "/api/open-broadcast");
    expect(writeAt).toBeGreaterThan(-1); expect(readAt).toBeGreaterThan(writeAt); expect(sendAt).toBeGreaterThan(readAt);
    expect(c.submitStage).toBe("pending"); expect(c.busy).toBe(true); expect(c.beamStatus.landedLabel).toBeNull(); expect(boundary.once).not.toHaveBeenCalled();
    chainStatus = "confirmed"; await advance(1); expect(c.submitStage).toBe("confirmed"); expect(c.beamStatus.landedLabel).toBe("Beam landed");
    expect(boundary.notify).toHaveBeenCalledWith(preparedValue.summary.nftMint); expect(boundary.once).toHaveBeenCalledWith(`open-ok:${signature}`, "open_position_success", { pool: pair.poolAddress, pair: "AAA/BBB" });
  });
  it("keeps preparing and wallet phases observable and blocks duplicate retained callbacks synchronously", async () => {
    await ready(); const wait = deferred<Response>(); prepareReply = () => wait.promise; const retained = c.signAndSend;
    let sending!: Promise<void>; await command("double send", () => { sending = retained(); void retained(); });
    expect(c.submitStage).toBe("preparing"); expect(c.busy).toBe(true); expect(calls("/api/open-prepare")).toHaveLength(1);
    const signing = holdSign(); await act(async () => wait.resolve(Response.json(preparedValue)));
    expect(c.submitStage).toBe("wallet"); expect(c.quote).toEqual(preparedValue.summary.quote);
    await command("retained callback during wallet", () => { void retained(); }); expect(calls("/api/open-prepare")).toHaveLength(1);
    await act(async () => { signing.release(); await sending; }); expect(c.submitStage).toBe("pending");
  });
  it.each(["prepare-network", "prepare-http", "prepare-json", "wallet-reject", "wallet-non-error"])("preserves error/finally and allows a later retry after %s", async failure => {
    await ready(); const normalPrepare = prepareReply, normalSign = boundary.sign.getMockImplementation()!;
    if (failure === "prepare-network") prepareReply = async () => { throw new Error("network unavailable"); };
    if (failure === "prepare-http") prepareReply = async () => Response.json({ error: "simulation failed" }, { status: 400 });
    if (failure === "prepare-json") prepareReply = async () => new Response("{broken");
    if (failure === "wallet-reject") boundary.sign.mockRejectedValue(new Error("User rejected request"));
    if (failure === "wallet-non-error") boundary.sign.mockRejectedValue("synthetic rejection");
    await send(); expectNoSend(); expect(c.busy).toBe(false); expect(c.submitStage).toBeNull(); expect(c.error).not.toBe("");
    expect(boundary.growth.mock.calls.map(x => x[0])).toEqual(["open_position_started", "open_position_failed"]);
    prepareReply = normalPrepare; boundary.sign.mockImplementation(normalSign); await advance(450); await send(); expect(calls("/api/open-broadcast")).toHaveLength(1);
  });
  it.each(["wallet", "pool", "amount", "mint", "kind", "expired", "permit", "bytes", "payer", "nft", "blockhash"])("rejects prepared %s mismatch before signing", async mismatch => {
    await ready();
    if (mismatch === "wallet") preparedValue.summary.wallet = testKeypair(3).publicKey.toBase58();
    if (mismatch === "pool") preparedValue.summary.poolId = pair.mintA;
    if (mismatch === "amount") preparedValue.summary.quote.requested = "7";
    if (mismatch === "mint") preparedValue.summary.quote.inputMint = pair.mintA;
    if (mismatch === "kind") preparedValue.summary.quote.inputKind = "native";
    if (mismatch === "expired") preparedValue.summary.expiresAt = Date.now();
    if (mismatch === "permit") preparedValue.permit = "";
    if (mismatch === "bytes") preparedValue.unsignedTransaction = "not-base64";
    if (mismatch === "payer") preparedValue.unsignedTransaction = toBase64(buildTransaction({ payer: testKeypair(3), extraSigners: [nft], signWith: [nft] }));
    if (mismatch === "nft") preparedValue.summary.nftMint = pair.mintA;
    if (mismatch === "blockhash") preparedValue.summary.blockhash = pair.mintA;
    await send(); expectNoSend(); expect(boundary.sign).not.toHaveBeenCalled(); expect(c.error).not.toBe(""); expect(c.busy).toBe(false);
  });
  it.each(["changed-message", "zero-payer", "missing-nft", "count"])("rejects wallet %s before storage or broadcast", async bad => {
    await ready();
    boundary.sign.mockImplementation(async (tx: VersionedTransaction) => { const result = signed(tx);
      if (bad === "changed-message") result.message.recentBlockhash = pair.mintA;
      if (bad === "zero-payer") result.signatures[0] = new Uint8Array(64);
      if (bad === "missing-nft") return buildTransaction({ payer, signWith: [payer] });
      if (bad === "count") result.signatures = [];
      note("sign-output", toBase64(result)); return result;
    });
    await send(); expectNoSend(); expect(c.error).not.toBe(""); expect(c.busy).toBe(false);
  });
  it("adds the NFT mint signature after the wallet drops that slot", async () => {
    await ready(); boundary.sign.mockImplementation(async (tx: VersionedTransaction) => { const result = signed(tx); result.signatures[1] = new Uint8Array(64); note("sign-output", toBase64(result)); return result; });
    await send(); const body = JSON.parse(calls("/api/open-broadcast")[0]![1].body); const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    expect(tx.signatures[1]?.some((byte: number) => byte !== 0)).toBe(true); expect(body.unsignedTransaction).toBe(preparedValue.unsignedTransaction); expect(c.submitStage).toBe("pending");
  });
  it.each(["throw", "drop"] as const)("does not send on storage %s and reports failure before finally unlock", async bad => {
    await ready(); writeMode = bad; await send(); expectNoSend(); expect(c.error).toContain(bad === "throw" ? "storage denied" : "Unable to save"); expect(c.busy).toBe(false); expect(boundary.growth).toHaveBeenLastCalledWith("open_position_failed", expect.any(Object));
  });
  it.each(["network", "http", "json", "mismatch", "sent-false"])("preserves original durable ownership for broadcast %s", async result => {
    await ready(); broadcastReply = async () => {
      if (result === "network") throw new Error("socket hang up");
      if (result === "json") return new Response("{broken");
      if (result === "mismatch") return Response.json({ signature: "other-signature" });
      return Response.json({ error: "simulation failed", ...(result === "sent-false" ? { sent: false } : {}) }, { status: 400 });
    };
    await send(); await advance(450);
    expect(calls("/api/open-broadcast")).toHaveLength(1);
    if (result === "sent-false") { expect(storage.getItem(openAttemptKey(wallet))).toBeNull(); expect(c.busy).toBe(false); expect(c.error).toContain("safe to retry"); expect(boundary.growth).toHaveBeenLastCalledWith("open_position_failed", expect.any(Object)); }
    else { expect(storage.getItem(openAttemptKey(wallet))).toContain(c.signature); expect(c.signature).not.toBe(""); expect(c.busy).toBe(true); expect(c.error).toContain("unconfirmed"); expect(boundary.growth.mock.calls.map(x => x[0])).toEqual(["open_position_started"]); await send(); expect(boundary.sign).toHaveBeenCalledTimes(1); }
  });
  it.each(["wallet", "form", "pool", "unmount", "activity", "suspense", "expiry"])("stops late wallet result after %s", async change => {
    await ready(); const signing = holdSign(); let sending!: Promise<void>; await command("send", () => { sending = c.signAndSend(); });
    if (change === "wallet") { boundary.wallet = testKeypair(3).publicKey.toBase58(); await render(); }
    if (change === "form") await command("change amount", () => c.changeAmount("0.003"));
    if (change === "pool") { currentPair = { ...pair, poolAddress: pair.mintA }; await render(); }
    if (change === "unmount") { await act(async () => root.unmount()); root = createRoot(container); }
    if (change === "activity") { mode = "hidden"; await render(); }
    if (change === "suspense") { suspend = true; await render(); }
    if (change === "expiry") { note("clock jump"); vi.setSystemTime(preparedValue.summary.expiresAt); }
    await act(async () => { signing.release(); await sending; }); expectNoSend();
  });
  it.each(["prepare", "json"])("checks current identity after awaiting %s", async phase => {
    await ready(); const wait = deferred<Response>(), json = deferred<ReturnType<typeof prepared>>();
    if (phase === "prepare") prepareReply = () => wait.promise;
    else prepareReply = async () => { const response = Response.json({}); response.json = () => json.promise; return response; };
    let sending!: Promise<void>; await command("send", () => { sending = c.signAndSend(); });
    await command("change amount", () => c.changeAmount("0.003"));
    await act(async () => { if (phase === "prepare") wait.resolve(Response.json(preparedValue)); else json.resolve(preparedValue); await sending; });
    expectNoSend(); expect(boundary.sign).not.toHaveBeenCalled();
  });
  it("revokes retained same-value/ABA signing ownership", async () => {
    await ready(); const signing = holdSign(); let sending!: Promise<void>; await command("send", () => { sending = c.signAndSend(); });
    await command("ABA input", () => { c.changeAmount("0.003"); c.changeAmount("0.002"); });
    await act(async () => { signing.release(); await sending; }); expectNoSend();
  });
  it.each(["activity", "suspense"])("revokes same-identity %s hide/reveal before signing resolves", async change => {
    await ready(); const signing = holdSign(); let sending!: Promise<void>; await command("send", () => { sending = c.signAndSend(); });
    if (change === "activity") mode = "hidden"; else suspend = true; await render();
    mode = "visible"; suspend = false; await render(); await advance(1);
    await act(async () => { signing.release(); await sending; }); expectNoSend();
  });
  it.each(["failed", "expired"])("reports confirmed-chain %s analytics with original signature", async status => {
    await ready(); await send(); chainStatus = status; await advance(1);
    expect(boundary.once).toHaveBeenCalledWith(`open-fail:${c.signature}`, "open_position_failed", { pool: pair.poolAddress, pair: "AAA/BBB", error_class: status === "expired" ? "expired" : "onchain_failed" });
  });
  it("does not display previous Beam metadata after another attempt is confirmed", async () => {
    await ready(); await send(); chainStatus = "confirmed"; await advance(1); expect(c.beamStatus.landedLabel).toBe("Beam landed");
    await command("new position", () => c.createAnother()); await advance(450);
    const tx = buildTransaction({ payer, extraSigners: [nft], signWith: [], blockhash: pair.mintA });
    preparedValue.unsignedTransaction = toBase64(tx); preparedValue.summary.blockhash = tx.message.recentBlockhash;
    broadcastReply = async () => { throw new Error("lost response"); }; chainStatus = "pending"; await send();
    chainStatus = "confirmed"; await advance(1); expect(c.submitStage).toBe("confirmed"); expect(c.beamStatus.landedLabel).toBeNull();
  });
  it("retains discovery and submission shared-error clearing semantics", async () => {
    scanError = true; await render(); await advance(1); expect(c.error).toBe("Synthetic scan failure");
    await command("clear form", () => c.changeAmount("0.002")); expect(c.error).toBe(""); expect(boundary.sign).not.toHaveBeenCalled();
  });
  it("blocks absent form, absent pair, unloaded wallet and expired retained quote before prepare", async () => {
    await render(); await send(); await advance(1); await send(); expect(calls("/api/open-prepare")).toHaveLength(0);
    await command("amount", () => c.changeAmount("0.002")); await advance(450); const retained = c.signAndSend;
    vi.setSystemTime(preparedValue.summary.quote.expiresAt); await act(async () => retained()); expect(calls("/api/open-prepare")).toHaveLength(0);
    currentPair = null; await render(); await send(); boundary.wallet = undefined; await render(); await send(); expect(calls("/api/open-prepare")).toHaveLength(0);
  });
});
