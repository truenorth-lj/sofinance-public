// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { WithdrawPanel } from "./withdraw-panel";
import { withdrawCheckpoint, withdrawKey, withdrawPosition, withdrawPrepared, withdrawSigner, withdrawWallet, signedWithdraw } from "@/lib/test-support/withdraw-checkpoint-fixtures";

const mocks = vi.hoisted(() => ({ sign: vi.fn(), history: vi.fn(), confirmed: vi.fn(), busy: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: withdrawWallet, connected: true, signTransaction: mocks.sign }) }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: mocks.history }));
let root: Root, container: HTMLDivElement;
let events: { event: string; value?: unknown }[];
let prepared: ReturnType<typeof withdrawPrepared>;
let fetcher: Mock<(path: string, init: RequestInit) => Promise<Response>>;
const rawGet = Storage.prototype.getItem, rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
function raw() { return rawGet.call(localStorage, withdrawKey); }
function record(event: string, value?: unknown) { events.push({ event, value }); }
function calls(path: string) { return fetcher.mock.calls.filter(([url]) => url === `/api/withdraw-${path}`); }
function button(text: string) { return Array.from(container.querySelectorAll("button")).find(b => b.textContent === text); }
async function click(text: string) { await act(async () => button(text)?.click()); }
async function render() { await act(async () => root.render(createElement(WithdrawPanel, { wallet: withdrawWallet, positionMint: withdrawPosition, mintA: withdrawPosition, mintB: withdrawWallet, label: m => m, onClose: vi.fn(), onConfirmed: mocks.confirmed, onBusyChange: mocks.busy }))); }
async function remount() { await act(async () => root.unmount()); root = createRoot(container); await render(); }
async function fresh() { await render(); await click("Preview"); await click("Withdraw"); }
beforeEach(() => {
 localStorage.clear(); vi.resetAllMocks(); events = []; prepared = withdrawPrepared();
 container = document.createElement("div"); document.body.append(container); root = createRoot(container);
 (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
 vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function(this: HTMLDialogElement) { this.setAttribute("open", ""); });
 vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function(this: HTMLDialogElement) { this.removeAttribute("open"); });
 vi.spyOn(localStorage, "getItem").mockImplementation(function(this: Storage, key) { const value = rawGet.call(this, key); record("get", { key, raw: value }); return value; });
 vi.spyOn(localStorage, "setItem").mockImplementation(function(this: Storage, key, value) { record("set", { key, raw: value }); rawSet.call(this, key, value); });
 vi.spyOn(localStorage, "removeItem").mockImplementation(key => { record("remove", key); rawRemove.call(localStorage, key); });
 mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([withdrawSigner]); record("sign", bs58.encode(tx.signatures[0]!)); return tx; });
 mocks.history.mockImplementation((...args) => record("notify", args)); mocks.confirmed.mockImplementation(() => record("confirmed"));
 fetcher = vi.fn(async (path: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string); record(path, body);
  if (path === "/api/withdraw-quote") return Response.json(prepared.summary);
  if (path === "/api/withdraw-prepare") return Response.json(prepared);
  if (path === "/api/withdraw-broadcast") return Response.json({ accepted: true });
  if (path === "/api/withdraw-status") return Response.json({ status: "success" });
  throw new Error(`Unexpected request ${path}`);
 });
 vi.stubGlobal("fetch", fetcher);
});
afterEach(async context => {
 await act(async () => root.unmount()); container.remove();
 // eslint-disable-next-line no-console -- Synthetic event ledger for local RED/GREEN evidence; no real keys or network.
 console.info(JSON.stringify({ case: context.task.name, key: withdrawKey, raw: raw(), events, counts: { prepare: calls("prepare").length, sign: mocks.sign.mock.calls.length, send: calls("broadcast").length, status: calls("status").length, notify: mocks.history.mock.calls.length, confirmed: mocks.confirmed.mock.calls.length } }));
 vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it.each(["{invalid", "null", "false", "0", '""', "[]", "{}", '{"prepared":null}', '{"prepared":{"summary":null}}'])("blocks malformed history without losing raw: %s", async value => {
 rawSet.call(localStorage, withdrawKey, value);
 await fresh(); await click("Resume withdrawal"); await click("Confirm high price impact");
 expect(calls("prepare")).toHaveLength(0); expect(calls("status")).toHaveLength(0);
 expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("broadcast")).toHaveLength(0);
 expect(raw()).toBe(value); expect(container.textContent).toMatch(/withdrawal history|storage/i);
});
it("blocks unreadable history instead of signing a new transaction", async () => {
 vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error("read denied"); });
 await fresh(); await click("Resume withdrawal");
 expect(calls("prepare")).toHaveLength(0); expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("broadcast")).toHaveLength(0); expect(calls("status")).toHaveLength(0);
 expect(container.textContent).toMatch(/withdrawal history|storage/i);
});
it.each(["failed", "expired"])("retains rootless swap history instead of clearing it on %s and allowing principal retry", async status => {
 const saved = withdrawCheckpoint("swap"); delete saved.root;
 const original = JSON.stringify(saved); rawSet.call(localStorage, withdrawKey, original);
 fetcher.mockResolvedValueOnce(Response.json({ status }));
 await render(); await click("Resume withdrawal");
 await click("Retry withdrawal"); await click("Preview"); await click("Withdraw"); await click("Confirm high price impact");
 expect(raw()).toBe(original); expect(container.textContent).toMatch(/withdrawal history|storage/i);
 expect(fetcher).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
 expect(mocks.confirmed).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
 expect(mocks.busy).toHaveBeenLastCalledWith(true);
 expect(events.filter(e => e.event === "set" || e.event === "remove")).toEqual([]);
 await remount(); await click("Resume withdrawal"); await click("Withdraw");
 expect(raw()).toBe(original); expect(fetcher).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
});
it.each(["throw", "drop"])("does not broadcast when checkpoint setItem %s", async mode => {
 vi.mocked(localStorage.setItem).mockImplementation((key, value) => { record(`set-${mode}`, { key, raw: value }); if (mode === "throw") throw new Error("quota"); });
 await fresh();
 expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("prepare")).toHaveLength(1);
 expect(calls("broadcast")).toHaveLength(0); expect(calls("status")).toHaveLength(0); expect(mocks.confirmed).not.toHaveBeenCalled(); expect(raw()).toBeNull();
 expect(container.textContent).toMatch(/withdrawal history|storage/i);
});
it("healthy atomic operation persists before broadcast and completes", async () => {
 await fresh();
 expect(calls("prepare")).toHaveLength(1); expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("broadcast")).toHaveLength(1); expect(calls("status")).toHaveLength(1);
 const write = events.findIndex(e => e.event === "set"), send = events.findIndex(e => e.event === "/api/withdraw-broadcast"); expect(write).toBeGreaterThanOrEqual(0); expect(write).toBeLessThan(send);
 expect(events.slice(write + 1, send).some(e => e.event === "get" && (e.value as { raw: string }).raw === (events[write]!.value as { raw: string }).raw)).toBe(true);
 const remove = events.findIndex(e => e.event === "remove"), done = events.findIndex(e => e.event === "confirmed");
 expect(remove).toBeGreaterThan(send); expect(events.slice(remove + 1, done).some(e => e.event === "get" && (e.value as { raw: string | null }).raw === null)).toBe(true);
 expect(mocks.confirmed).toHaveBeenCalledOnce(); expect(raw()).toBeNull();
});
it("valid persisted history resumes the exact S1 with no new signing or send", async () => {
 const saved = withdrawCheckpoint(); rawSet.call(localStorage, withdrawKey, JSON.stringify(saved));
 await render(); await click("Resume withdrawal");
 expect(JSON.parse(calls("status")[0]![1].body as string)).toEqual({ signature: saved.signature, prepared: saved.prepared });
 expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("prepare")).toHaveLength(0); expect(calls("broadcast")).toHaveLength(0); expect(mocks.confirmed).toHaveBeenCalledOnce();
});
it("unknown send survives remount and only queries the original signature", async () => {
 fetcher.mockImplementation(async (path: string, init: RequestInit) => { record(path, JSON.parse(init.body as string)); if (path.endsWith("quote")) return Response.json(prepared.summary); if (path.endsWith("prepare")) return Response.json(prepared); if (path.endsWith("broadcast")) throw new Error("lost response"); return Response.json({ status: "success" }); });
 await fresh(); const saved = JSON.parse(raw()!); expect(saved.signature).toBe(signedWithdraw(prepared).signature);
 await remount(); await click("Resume withdrawal");
 expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("broadcast")).toHaveLength(1); expect(JSON.parse(calls("status")[0]![1].body as string).signature).toBe(saved.signature); expect(raw()).toBeNull();
});

it.each(["read-throw", "changed-bytes"])("blocks send when set readback is %s, preserving written evidence for reload", async mode => {
 let written = false;
 vi.mocked(localStorage.setItem).mockImplementation((key, value) => { record("set", { key, raw: value }); rawSet.call(localStorage, key, value); written = true; });
 vi.mocked(localStorage.getItem).mockImplementation(key => {
  if (written) { record(mode); if (mode === "read-throw") throw new Error("readback denied"); return raw() + " "; }
  const value = rawGet.call(localStorage, key); record("get", { key, raw: value }); return value;
 });
 await fresh(); const durable = raw();
 expect(durable).not.toBeNull(); expect(JSON.parse(durable!).signature).toBe(signedWithdraw(prepared).signature);
 expect(calls("broadcast")).toHaveLength(0); expect(calls("status")).toHaveLength(0); expect(mocks.confirmed).not.toHaveBeenCalled();
 vi.mocked(localStorage.getItem).mockImplementation(key => rawGet.call(localStorage, key));
 await remount(); await click("Resume withdrawal");
 expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("broadcast")).toHaveLength(0); expect(calls("status")).toHaveLength(1); expect(mocks.confirmed).toHaveBeenCalledOnce();
});

it.each(["throw", "drop", "read-throw"])("does not publish completion when removeItem %s", async mode => {
 const saved = withdrawCheckpoint(); const original = JSON.stringify(saved); rawSet.call(localStorage, withdrawKey, original);
 vi.spyOn(localStorage, "removeItem").mockImplementation(key => {
  record(`remove-${mode}`, key);
  if (mode === "throw") throw new Error("remove denied");
  if (mode === "read-throw") { rawRemove.call(localStorage, key); vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error("readback denied"); }); }
 });
 await render(); await click("Resume withdrawal");
 expect(calls("status")).toHaveLength(1); expect(mocks.confirmed).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("Withdrawal complete");
 expect(button("Resume withdrawal")).toBeDefined(); expect(button("Resume withdrawal")!.disabled).toBe(true);
 expect(raw()).toBe(mode === "read-throw" ? null : original);
 expect(calls("prepare")).toHaveLength(0); expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("broadcast")).toHaveLength(0);
});
it.each(["failed", "expired"])("keeps first checkpoint after %s when removal is dropped", async status => {
 const original = JSON.stringify(withdrawCheckpoint("withdraw")); rawSet.call(localStorage, withdrawKey, original);
 vi.spyOn(localStorage, "removeItem").mockImplementation(key => record("remove-drop", key));
 fetcher.mockResolvedValue(Response.json({ status }));
 await render(); await click("Resume withdrawal");
 expect(raw()).toBe(original); expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.confirmed).not.toHaveBeenCalled(); expect(button("Retry withdrawal")).toBeUndefined();
 expect(calls("quote")).toHaveLength(0); expect(calls("prepare")).toHaveLength(0);
});

function twoStage() {
 const first = withdrawPrepared("withdraw"); const s1 = signedWithdraw(first).signature;
 const second = withdrawPrepared("swap", { tx1Signature: s1 }); prepared = first;
 fetcher.mockImplementation(async (path: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string); record(path, body);
  if (path.endsWith("quote")) return Response.json(body.stage === "swap" ? second.summary : first.summary);
  if (path.endsWith("prepare")) { prepared = body.stage === "swap" ? second : first; return Response.json(prepared); }
  if (path.endsWith("broadcast")) { if (body.summary.stage === "swap") throw new Error("unknown S2"); return Response.json({ accepted: true }); }
  if (path.endsWith("status")) return Response.json({ status: "success" });
  throw new Error(`Unexpected ${path}`);
 });
 return { first, second, s1, s2: signedWithdraw(second).signature };
}
it("two-stage unknown S2 reload retains complete first prepared and S1, and success uses force-only refresh", async () => {
 const { first, second, s1, s2 } = twoStage();
 await fresh();
 expect(mocks.history.mock.calls).toEqual([[withdrawPosition, s1]]); expect(mocks.confirmed).not.toHaveBeenCalled();
 const saved = JSON.parse(raw()!); expect(saved.root).toEqual({ prepared: first, signature: s1 }); expect(saved.prepared).toEqual(second); expect(saved.signature).toBe(s2);
 for (const [, init] of [...calls("quote"), ...calls("prepare")]) {
  const body = JSON.parse(init.body as string); if (body.stage === "swap") expect(body).toMatchObject({ previous: first, tx1Signature: s1, percent: 100, receive: "usdc", wallet: withdrawWallet, positionMint: withdrawPosition });
 }
 await remount(); await click("Resume withdrawal");
 expect(mocks.sign).toHaveBeenCalledTimes(2); expect(calls("broadcast")).toHaveLength(2); expect(calls("prepare")).toHaveLength(2);
 expect(mocks.history.mock.calls).toEqual([[withdrawPosition, s1], [withdrawPosition, undefined]]); expect(mocks.confirmed).toHaveBeenCalledOnce(); expect(raw()).toBeNull();
});
it.each(["failed", "expired"])("swap %s Resume restores the root and re-prepares conversion in one click", async status => {
 const saved = withdrawCheckpoint("swap", { wallet: withdrawWallet, positionMint: withdrawPosition, targetUSDC: 12.34, receive: "token", outputMint: withdrawPosition, confirmHighImpact: true });
 rawSet.call(localStorage, withdrawKey, JSON.stringify(saved));
 const first = saved.root!.prepared, s1 = saved.root!.signature;
 const second = withdrawPrepared("swap", { tx1Signature: s1 });
 fetcher.mockImplementation(async (path: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string); record(path, body);
  if (path.endsWith("quote")) return Response.json(body.stage === "swap" ? second.summary : first.summary);
  if (path.endsWith("prepare")) { prepared = body.stage === "swap" ? second : first; return Response.json(prepared); }
  if (path.endsWith("broadcast")) return Response.json({ accepted: true });
  if (path.endsWith("status")) return Response.json({ status: "success" });
  throw new Error(`Unexpected ${path}`);
 });
 fetcher.mockResolvedValueOnce(Response.json({ status }));
 await render(); await click("Resume withdrawal");
 expect(calls("prepare")).toHaveLength(1); const request = JSON.parse(calls("prepare")[0]![1].body as string);
 expect(request).toMatchObject({ ...saved.request, confirmHighImpact: false, stage: "swap", previous: first, tx1Signature: s1 });
 expect(request.previous.unsignedTransaction).toBe(first.unsignedTransaction); expect(request.tx1Signature).toBe(s1);
 expect(mocks.sign).toHaveBeenCalledOnce();
 expect(mocks.history.mock.calls).toEqual([[withdrawPosition, s1], [withdrawPosition, undefined]]);
 expect(mocks.confirmed).toHaveBeenCalledOnce(); expect(raw()).toBeNull();
});
it("convert SOL-budget rejection restores S1 so Resume re-prepares conversion", async () => {
 const first = withdrawPrepared("withdraw"); const s1 = signedWithdraw(first).signature;
 const second = withdrawPrepared("swap", { tx1Signature: s1 });
 let failConvert = true;
 fetcher.mockImplementation(async (path: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string); record(path, body);
  if (path.endsWith("quote")) return Response.json(body.stage === "swap" ? second.summary : first.summary);
  if (path.endsWith("prepare")) { prepared = body.stage === "swap" ? second : first; return Response.json(prepared); }
  if (path.endsWith("broadcast")) {
   if (body.summary.stage === "swap" && failConvert) {
    failConvert = false;
    return Response.json({ error: "Withdrawal exceeds SOL cost budget" }, { status: 400 });
   }
   return Response.json({ accepted: true });
  }
  if (path.endsWith("status")) return Response.json({ status: "success" });
  throw new Error(`Unexpected ${path}`);
 });
 prepared = first;
 await fresh();
 expect(container.textContent).toContain("Withdrawal exceeds SOL cost budget");
 expect(JSON.parse(raw()!).prepared).toEqual(first); expect(JSON.parse(raw()!).signature).toBe(s1);
 expect(JSON.parse(raw()!).root).toBeUndefined(); expect(mocks.confirmed).not.toHaveBeenCalled();
 await click("Resume withdrawal");
 expect(calls("prepare").filter(([, init]) => JSON.parse(init.body as string).stage === "swap")).toHaveLength(2);
 expect(mocks.confirmed).toHaveBeenCalledOnce(); expect(raw()).toBeNull();
});
it.each(["throw", "drop", "read-throw"])("failed swap retains S2 and its root when restoration write %s", async mode => {
 const saved = withdrawCheckpoint("swap"), original = JSON.stringify(saved); rawSet.call(localStorage, withdrawKey, original);
 vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
  record(`restore-${mode}`, { key, raw: value });
  if (mode === "throw") throw new Error("restore denied");
  if (mode === "read-throw") { rawSet.call(localStorage, key, value); vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error("readback denied"); }); }
 });
 fetcher.mockResolvedValue(Response.json({ status: "failed" }));
 await render(); await click("Resume withdrawal");
 expect(button("Resume withdrawal")!.disabled).toBe(true); expect(mocks.confirmed).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
 expect(calls("prepare")).toHaveLength(0); expect(calls("broadcast")).toHaveLength(0); expect(mocks.history).not.toHaveBeenCalled();
 if (mode !== "read-throw") expect(raw()).toBe(original); else expect(JSON.parse(raw()!).prepared).toEqual(saved.root!.prepared);
});
it.each(["manual-review", "network"])("retains original signature and raw on %s status", async status => {
 const saved = withdrawCheckpoint(), original = JSON.stringify(saved); rawSet.call(localStorage, withdrawKey, original);
 if (status === "network") fetcher.mockRejectedValue(new Error("network")); else fetcher.mockResolvedValue(Response.json({ status }));
 await render(); await click("Resume withdrawal");
 expect(raw()).toBe(original); expect(calls("status")).toHaveLength(1); expect(mocks.confirmed).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
});
it("pending first status does not start stage two; explicit finality then continues", async () => {
 vi.useFakeTimers(); const { s1 } = twoStage();
 const saved = withdrawCheckpoint("withdraw"); rawSet.call(localStorage, withdrawKey, JSON.stringify(saved));
 fetcher.mockResolvedValueOnce(Response.json({ status: "pending" }));
 await render(); await click("Resume withdrawal");
 expect(calls("status")).toHaveLength(1); expect(calls("quote")).toHaveLength(0); expect(mocks.sign).not.toHaveBeenCalled();
 await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
 expect(mocks.history).toHaveBeenCalledWith(withdrawPosition, s1); expect(calls("prepare")).toHaveLength(1); expect(mocks.sign).toHaveBeenCalledOnce();
 expect(vi.getTimerCount()).toBe(0);
});
it("second signing rejection retains first prepared and S1 for a later Resume", async () => {
 const { first, s1 } = twoStage();
 mocks.sign.mockImplementationOnce(async tx => { tx.sign([withdrawSigner]); return tx; }).mockRejectedValueOnce(new Error("wallet rejected"));
 await fresh();
 expect(JSON.parse(raw()!).prepared).toEqual(first); expect(JSON.parse(raw()!).signature).toBe(s1);
 expect(mocks.history).toHaveBeenCalledWith(withdrawPosition, s1); expect(calls("broadcast")).toHaveLength(1);
 await click("Resume withdrawal");
 expect(calls("prepare")).toHaveLength(3); expect(JSON.parse(calls("prepare")[2]![1].body as string).stage).toBe("swap");
 expect(calls("broadcast")).toHaveLength(2); expect(JSON.parse(raw()!).root).toEqual({ prepared: first, signature: s1 });
});

it("high-impact cancel does not prepare; confirm keeps the original request and rechecks storage", async () => {
 prepared = withdrawPrepared("atomic", { priceImpactBps: 600, warning: true, requiresSecondConfirmation: true });
 await render(); await click("Preview"); await click("Withdraw"); expect(container.querySelector("dialog")!.open).toBe(true);
 await click("Cancel"); expect(calls("prepare")).toHaveLength(0); expect(mocks.sign).not.toHaveBeenCalled();
 await click("Withdraw"); await click("Confirm high price impact");
 expect(calls("prepare")).toHaveLength(1); expect(JSON.parse(calls("prepare")[0]![1].body as string).confirmHighImpact).toBe(true);
 expect(mocks.confirmed).toHaveBeenCalledOnce();
});
it.each(["dialog", "prepare", "sign", "status", "retry"])("does not overwrite newly invalid history at the %s boundary", async boundary => {
 prepared = withdrawPrepared("atomic", boundary === "dialog" ? { requiresSecondConfirmation: true } : {});
 if (boundary === "prepare") {
  const normal = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (...args) => { const result = await normal(...args); if (args[0] === "/api/withdraw-prepare") rawSet.call(localStorage, withdrawKey, "{changed"); return result; });
 }
 if (boundary === "sign") mocks.sign.mockImplementation(async tx => { tx.sign([withdrawSigner]); rawSet.call(localStorage, withdrawKey, "{changed"); return tx; });
 if (boundary === "status") {
  const normal = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (...args) => { const result = await normal(...args); if (args[0] === "/api/withdraw-status") rawSet.call(localStorage, withdrawKey, "{changed"); return result; });
 }
 if (boundary === "retry") { rawSet.call(localStorage, withdrawKey, JSON.stringify(withdrawCheckpoint())); fetcher.mockResolvedValueOnce(Response.json({ status: "expired" })); await render(); await click("Resume withdrawal"); rawSet.call(localStorage, withdrawKey, "{changed"); await click("Retry withdrawal"); }
 else { await fresh(); if (boundary === "dialog") { rawSet.call(localStorage, withdrawKey, "{changed"); await click("Confirm high price impact"); } }
 expect(raw()).toBe("{changed"); expect(mocks.confirmed).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
 expect(calls("broadcast")).toHaveLength(boundary === "status" ? 1 : 0); expect(calls("prepare")).toHaveLength(["dialog", "retry"].includes(boundary) ? 0 : 1);
 expect(mocks.sign).toHaveBeenCalledTimes(["sign", "status"].includes(boundary) ? 1 : 0);
 expect(container.textContent).toMatch(/withdrawal history|storage/i);
});

it.each([
 ["request identity", (v: ReturnType<typeof withdrawCheckpoint>) => { v.request.wallet = withdrawPosition; }],
 ["summary identity", (v: ReturnType<typeof withdrawCheckpoint>) => { v.prepared.summary.positionMint = withdrawWallet; }],
 ["root identity", (v: ReturnType<typeof withdrawCheckpoint>) => { v.root!.prepared.summary.wallet = withdrawPosition; }],
 ["root signature", (v: ReturnType<typeof withdrawCheckpoint>) => { v.root!.signature = v.signature; }],
 ["outputs null", (v: ReturnType<typeof withdrawCheckpoint>) => { Object.assign(v.prepared.summary, { outputs: null }); }],
 ["output primitive", (v: ReturnType<typeof withdrawCheckpoint>) => { Object.assign(v.prepared.summary, { outputs: [1] }); }],
 ["fee legs object", (v: ReturnType<typeof withdrawCheckpoint>) => { Object.assign(v.prepared.summary.protocolFee, { legs: {} }); }],
 ["asset amount object", (v: ReturnType<typeof withdrawCheckpoint>) => { Object.assign(v.prepared.summary.assets[0]!, { amount: {} }); }],
 ["confirmation string", (v: ReturnType<typeof withdrawCheckpoint>) => { Object.assign(v, { confirmHighImpact: "true" }); }],
 ["bad bytes", (v: ReturnType<typeof withdrawCheckpoint>) => { v.prepared.unsignedTransaction = "unused"; }],
 ["bad signature", (v: ReturnType<typeof withdrawCheckpoint>) => { v.signature = "not-a-signature"; }],
 ["missing request", (v: ReturnType<typeof withdrawCheckpoint>) => { Object.assign(v, { request: null }); }],
] as const)("malformed nested %s is render-safe, retained, and cannot Resume", async (_name, mutate) => {
 const value = withdrawCheckpoint("swap"); mutate(value); const original = JSON.stringify(value); rawSet.call(localStorage, withdrawKey, original);
 await fresh(); await click("Resume withdrawal"); await click("Confirm high price impact");
 expect(calls("prepare")).toHaveLength(0); expect(calls("status")).toHaveLength(0); expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("broadcast")).toHaveLength(0);
 expect(raw()).toBe(original); expect(container.textContent).toMatch(/withdrawal history|storage/i); expect(mocks.busy).toHaveBeenLastCalledWith(true);
});

it("stage-two high impact cancellation keeps S1; confirmation forwards full original request and root", async () => {
 const { first, s1, second } = twoStage(); second.summary.requiresSecondConfirmation = true;
 await fresh();
 expect(container.querySelector("dialog")!.open).toBe(true); expect(calls("prepare")).toHaveLength(1); expect(mocks.sign).toHaveBeenCalledOnce();
 await click("Cancel"); expect(JSON.parse(raw()!).prepared).toEqual(first);
 await click("Resume withdrawal"); expect(container.querySelector("dialog")!.open).toBe(true);
 await click("Confirm high price impact");
 expect(JSON.parse(calls("prepare")[1]![1].body as string)).toMatchObject({ previous: first, tx1Signature: s1, confirmHighImpact: true });
 expect(JSON.parse(raw()!).root).toEqual({ prepared: first, signature: s1 }); expect(JSON.parse(raw()!).confirmHighImpact).toBe(true);
});
it("stage-two prepare failure keeps S1 and can later Resume conversion without withdrawing again", async () => {
 const { first, s1 } = twoStage(), normal = fetcher.getMockImplementation()!;
 let fail = true;
 fetcher.mockImplementation(async (path, init) => {
  if (path.endsWith("prepare") && JSON.parse(init.body as string).stage === "swap" && fail) { fail = false; record(path, JSON.parse(init.body as string)); return Response.json({ error: "conversion unavailable" }, { status: 503 }); }
  return normal(path, init);
 });
 await fresh(); expect(mocks.history).toHaveBeenCalledWith(withdrawPosition, s1); expect(JSON.parse(raw()!).prepared).toEqual(first); expect(mocks.sign).toHaveBeenCalledOnce();
 await click("Resume withdrawal"); expect(mocks.sign).toHaveBeenCalledTimes(2);
 expect(calls("prepare").map(([, init]) => JSON.parse(init.body as string).stage)).toEqual([undefined, "swap", "swap"]);
});
it("stale first prepare refresh is preserved in every stage-two request and root", async () => {
 const { first, s1 } = twoStage(), normal = fetcher.getMockImplementation()!;
 const stale = withdrawPrepared("withdraw", { expiresAt: Date.now() - 1 }); let firstPrepare = true;
 fetcher.mockImplementation(async (path, init) => {
  if (path.endsWith("prepare") && firstPrepare) { firstPrepare = false; record(path, JSON.parse(init.body as string)); return Response.json(stale); }
  return normal(path, init);
 });
 await fresh(); expect(calls("prepare")).toHaveLength(3); expect(mocks.sign).toHaveBeenCalledTimes(2);
 expect(JSON.parse(calls("prepare")[2]![1].body as string)).toMatchObject({ previous: first, tx1Signature: s1 });
 expect(JSON.parse(raw()!).root).toEqual({ prepared: first, signature: s1 });
});
it("terminal atomic expiry verifies removal and enables a healthy retry", async () => {
 rawSet.call(localStorage, withdrawKey, JSON.stringify(withdrawCheckpoint()));
 fetcher.mockResolvedValueOnce(Response.json({ status: "expired" }));
 await render(); await click("Resume withdrawal"); expect(raw()).toBeNull(); expect(button("Retry withdrawal")!.disabled).toBe(false);
 await click("Retry withdrawal"); expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("broadcast")).toHaveLength(1); expect(mocks.confirmed).toHaveBeenCalledOnce();
});
