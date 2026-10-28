// @vitest-environment happy-dom
import { Activity, act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import bs58 from "bs58";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { compoundAttemptKey, compoundReceiptsKey, persistCompoundAttempt, type CompoundAttempt } from "@sofinance/engine/compound-attempt";
import { POSITION_HISTORY_REFRESH_EVENT, POSITION_HISTORY_REFRESH_STORAGE_KEY } from "@/lib/position-history-refresh";
import { useCompoundController, type CompoundConfirmation } from "./use-compound-controller";

vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: wallet, connected: !!wallet, signTransaction: sign }) }));
let wallet: string | undefined, mint: string | undefined;
let fixture: ReturnType<typeof compoundHistoryFixture>, controller: ReturnType<typeof useCompoundController>;
let root: Root, container: HTMLDivElement, alive: boolean;
let ledger: unknown[], requests: { path: string; body: unknown; at: number }[];
let sign: ReturnType<typeof vi.fn>, callback: Mock<() => void>;
let confirm: (attempt: CompoundAttempt) => Response | Promise<Response>;
let prepare: () => Response | Promise<Response>;
let pending: Array<() => void>;
let eventListener: () => void;
let get: (key: string) => string | null;
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const count = () => requests.filter(r => r.path === "/api/compound-confirm").length;
const reply = (status: CompoundConfirmation["status"], chainStatus?: CompoundConfirmation["chainStatus"], signature = fixture.attempt.signature) =>
  Response.json({ signature, status, chainStatus, state: fixture.state });
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  pending.push(() => resolve(reply("pending")));
  return { promise, resolve: async (r: Response) => { await act(async () => { resolve(r); }); } };
}
function Probe() {
  const value = useCompoundController({ wallet, positionMint: mint, externalBlocked: false, onConfirmed: callback });
  useLayoutEffect(() => { controller = value; ledger.push({ type: "view", at: Date.now(), value: JSON.parse(JSON.stringify(value)) }); });
  return null;
}
async function render(mode: "visible" | "hidden" = "visible", strict = false) {
  const probe = <Activity mode={mode}><Probe /></Activity>;
  await act(async () => root.render(strict ? createElement(StrictMode, null, probe) : probe));
}
async function start(strict = false) { await render("visible", strict); await advance(1); await advance(1); }
function seed() { persistCompoundAttempt(localStorage, fixture.attempt); ledger.length = 0; }
function storage() { return Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, get(k)])); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); fixture = compoundHistoryFixture(); wallet = fixture.wallet; mint = fixture.state.positionMint;
  ledger = []; requests = []; pending = []; alive = true; sign = vi.fn();
  let serial = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`);
  callback = vi.fn(() => ledger.push({ type: "confirmed", at: Date.now() }));
  get = k => Storage.prototype.getItem.call(localStorage, k);
  const set = (k: string, raw: string) => Storage.prototype.setItem.call(localStorage, k, raw);
  const remove = (k: string) => Storage.prototype.removeItem.call(localStorage, k);
  vi.spyOn(localStorage, "getItem").mockImplementation(k => { const raw = get(k); ledger.push({ type: "get", k, raw, at: Date.now() }); return raw; });
  vi.spyOn(localStorage, "setItem").mockImplementation((k, raw) => { ledger.push({ type: "set", k, raw, at: Date.now() }); set(k, raw); });
  vi.spyOn(localStorage, "removeItem").mockImplementation(k => { ledger.push({ type: "remove", k, at: Date.now() }); remove(k); });
  eventListener = () => ledger.push({ type: "history", at: Date.now(), storage: storage() });
  window.addEventListener(POSITION_HISTORY_REFRESH_EVENT, eventListener);
  confirm = () => reply("pending", "pending");
  prepare = () => Response.json({ error: "fresh preparation failed" }, { status: 503 });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const request = { path, body, at: Date.now() }; requests.push(request); ledger.push({ type: "request", ...request });
    if (path === "/api/compound-state") return Response.json({ ...fixture.state, wallet: body.wallet, positionMint: body.positionMint });
    if (path === "/api/compound-confirm") return confirm(body.attempt);
    if (path === "/api/compound-prepare") return prepare();
    throw new Error(`Unexpected external request ${path}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async context => {
  if (alive) await act(async () => root.unmount());
  const before = requests.length;
  await act(async () => { pending.forEach(finish => finish()); }); await advance(40_000);
  expect(requests).toHaveLength(before); expect(sign).not.toHaveBeenCalled();
  expect(requests.filter(r => /broadcast/.test(r.path))).toEqual([]);
  for (const request of requests.filter(r => r.path === "/api/compound-confirm")) {
    const body = request.body as { wallet: string; attempt: CompoundAttempt };
    expect(body.wallet).toBe(body.attempt.wallet);
    expect(Object.keys(body)).toEqual(["wallet", "attempt"]);
  }
  // eslint-disable-next-line no-console -- Complete ordered base/overlay/final preservation evidence.
  console.log("COMPOUND_ATTEMPT_LEDGER " + JSON.stringify({ test: context.task.name, ledger, requests, storage: storage(), callbacks: callback.mock.calls.length }));
  window.removeEventListener(POSITION_HISTORY_REFRESH_EVENT, eventListener);
  container.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("real compound facade attempt protocol", () => {
  it.each(["valid", "invalid-attempt", "invalid-receipts", "read-throw"])("loads %s history without changing raw evidence or locking fresh compound", async kind => {
    seed(); const key = kind === "invalid-receipts" ? compoundReceiptsKey(wallet!) : compoundAttemptKey(wallet!);
    if (kind.startsWith("invalid")) localStorage.setItem(key, "{invalid retained bytes");
    const before = storage();
    if (kind === "read-throw") vi.mocked(localStorage.getItem).mockImplementation(k => { if (k === key) throw new Error("synthetic storage read failure"); return get(k); });
    await start();
    expect(controller.canCompound).toBe(true); expect(controller.busy).toBe(false); expect(storage()).toEqual(before);
    expect(controller.historyWarning).toContain(kind === "valid" ? "unresolved" : "cannot be verified");
    if (kind === "read-throw") expect(controller.error).toContain("Unable to read");
  });

  it.each([
    ["pending", "pending", true], ["pending", "success", true], ["manual-review", "success", false],
    ["manual-review", "unknown", true], ["success", "success", false], ["failed", "failed", false], ["expired", "expired", false],
    ["success", undefined, false], ["failed", undefined, false], ["expired", undefined, false],
  ] as const)("preserves receipt %s / chain %s independently (poll=%s)", async (status, chain, poll) => {
    seed(); confirm = () => reply(status, chain); await start();
    expect(controller.attemptStatus).toBe(status); expect(controller.confirmation?.chainStatus).toBe(chain);
    expect(controller.receiptReviewRequired).toBe(chain === "success" && status !== "success");
    expect(controller.canCompound).toBe(true); expect(controller.busy).toBe(false);
    expect(controller.receipts).toHaveLength(status === "failed" || status === "expired" ? 0 : 1);
    const before = count(); await advance(4_000); expect(count()).toBe(before + Number(poll));
    expect(callback).toHaveBeenCalledTimes(chain === "success" || ["success", "failed", "expired"].includes(status) ? 1 : 0);
  });

  it.each(["signature", "status", "chainStatus", "network"])("rejects %s observation then a valid same-signature recheck remains live", async fault => {
    seed(); confirm = () => {
      if (fault === "network") return Promise.reject(new Error("synthetic timeout"));
      return Response.json({ signature: fixture.attempt.signature, status: "success", chainStatus: "success", state: fixture.state,
        [fault]: "invalid" });
    };
    await start(); expect(controller.attemptStatus).toBe("pending"); expect(callback).not.toHaveBeenCalled();
    expect(controller.error).toBe(fault === "network" ? "" : "Transaction verification returned signature or status mismatch");
    confirm = () => reply("success", "success"); await advance(4_000);
    expect(controller.attemptStatus).toBe("success"); expect(controller.error).toBe(""); expect(callback).toHaveBeenCalledOnce();
  });

  it("latest request wins over an earlier pending result and terminal dedupe includes receipt status", async () => {
    seed(); const old = deferred(); confirm = () => old.promise; await start();
    confirm = () => reply("pending", "success"); await act(async () => controller.retryReconcile());
    expect(controller.attemptStatus).toBe("pending"); expect(callback).toHaveBeenCalledOnce();
    await old.resolve(reply("failed", "failed")); expect(controller.confirmation?.chainStatus).toBe("success");
    await act(async () => controller.retryReconcile()); expect(callback).toHaveBeenCalledOnce();
    confirm = () => reply("success", "success"); await act(async () => controller.retryReconcile()); expect(callback).toHaveBeenCalledTimes(2);
    await act(async () => controller.retryReconcile()); expect(callback).toHaveBeenCalledTimes(2);
  });

  it("uses latest callback without restarting a selected-NFT-independent historical poll", async () => {
    seed(); await start(); const old = callback;
    callback = vi.fn(() => ledger.push({ type: "latest-confirmed", at: Date.now() }));
    mint = testKeypair(81).publicKey.toBase58(); await render(); await advance(1);
    expect(count()).toBe(1); confirm = () => reply("success", "success"); await advance(4_000);
    expect(count()).toBe(2); expect(old).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledOnce();
    expect(controller.state?.positionMint).toBe(mint);
    expect(requests.filter(r => r.path === "/api/compound-state")).toHaveLength(3);
  });

  it("30-second feedback uses createdAt and a deferred poll never overlaps", async () => {
    fixture = compoundHistoryFixture(Date.now() - 20_000); seed();
    const first = deferred(); confirm = () => first.promise; await start();
    await advance(9_997); expect(controller.confirmationSlow).toBe(false);
    await advance(1); expect(controller.confirmationSlow).toBe(true); expect(count()).toBe(1);
    await advance(10_000); expect(count()).toBe(1);
    await first.resolve(reply("pending", "pending"));
    confirm = () => reply("success", "success"); await advance(4_000);
    expect(count()).toBe(2); expect(controller.confirmationSlow).toBe(false);
  });

  it("receipt removal precedes terminal history and callback, and repeated success still refreshes receipt storage", async () => {
    if (fixture.attempt.kind !== "compound") throw new Error("compound fixture required");
    fixture.attempt.summary.priorSources = fixture.attempt.summary.compoundAccounts.map(a => ({ ...a, amount: "1", destination: fixture.wallet, refundLamports: a.rentLamports, sourceSignature: bs58.encode(new Uint8Array(64).fill(8)) }));
    seed(); const source = { wallet, positionMint: mint, sourceSignature: bs58.encode(new Uint8Array(64).fill(8)), compoundAccounts: fixture.attempt.summary.compoundAccounts };
    const own = JSON.parse(get(compoundReceiptsKey(wallet!))!);
    localStorage.setItem(compoundReceiptsKey(wallet!), JSON.stringify([...own, source])); ledger.length = 0;
    confirm = () => reply("success", "success"); await start();
    expect(controller.receipts.map(r => r.sourceSignature)).toEqual([fixture.attempt.signature]);
    const types = ledger as { type: string; k?: string; storage?: Record<string, string> }[];
    const receiptWrite = types.findIndex(e => e.type === "set" && e.k === compoundReceiptsKey(wallet!));
    const historyWrite = types.findIndex(e => e.type === "set" && e.k === POSITION_HISTORY_REFRESH_STORAGE_KEY);
    expect(receiptWrite).toBeGreaterThanOrEqual(0); expect(receiptWrite).toBeLessThan(historyWrite);
    expect(historyWrite).toBeLessThan(types.findIndex(e => e.type === "confirmed"));
    await act(async () => controller.retryReconcile()); expect(callback).toHaveBeenCalledOnce();
    expect(types.filter(e => e.type === "set" && e.k === compoundReceiptsKey(wallet!))).toHaveLength(2);
  });

  it("fresh prepare invalidates old confirmation, keeps its own error, then resumes the original S0", async () => {
    seed(); const old = deferred(), preparing = deferred(); confirm = () => old.promise; prepare = () => preparing.promise;
    await start(); await act(async () => controller.compound()); expect(controller.stage).toBe("preparing");
    await old.resolve(reply("success", "success")); expect(callback).not.toHaveBeenCalled();
    await preparing.resolve(Response.json({ error: "new operation error" }, { status: 503 }));
    expect(controller.error).toBe("new operation error"); expect(controller.busy).toBe(false);
    confirm = () => reply("expired", "expired"); await advance(4_000);
    expect(controller.attemptStatus).toBe("expired"); expect(controller.error).toBe("new operation error");
    expect(controller.attempt?.signature).toBe(fixture.attempt.signature);
  });

  it.each(["switch", "retained-ABA"])("records baseline wallet %s before the zero-delay reset", async mode => {
    seed(); const old = deferred(); confirm = () => old.promise; await start();
    wallet = testKeypair(82).publicKey.toBase58(); await render();
    if (mode === "retained-ABA") { wallet = fixture.wallet; await render(); }
    await old.resolve(reply("success", "success"));
    // Existing equality guard accepts retained A->B->A before the reset timer. This is characterization, not an epoch guarantee.
    expect(callback).toHaveBeenCalledTimes(mode === "retained-ABA" ? 1 : 0);
    confirm = attempt => reply("pending", "pending", attempt.signature); await advance(1); await advance(1);
    expect(controller.attempt?.wallet ?? null).toBe(mode === "retained-ABA" ? fixture.wallet : null);
  });

  it.each(["remount", "activity", "strict"])("preserves %s cleanup and starts a live new poll", async mode => {
    seed(); await start(mode === "strict"); expect(count()).toBe(1);
    if (mode === "activity") await render("hidden");
    else { await act(async () => root.unmount()); alive = false; }
    await advance(8_000); expect(count()).toBe(1);
    if (mode !== "activity") { root = createRoot(container); alive = true; }
    // Baseline Activity reconnect starts the retained poll, then reloads a new attempt object and starts it again.
    await start(mode === "strict"); expect(count()).toBe(mode === "activity" ? 3 : 2);
    confirm = () => reply("success", "success"); await advance(4_000); expect(callback).toHaveBeenCalledOnce();
  });
});
