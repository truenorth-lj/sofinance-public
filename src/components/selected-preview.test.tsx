// @vitest-environment happy-dom
import { Activity, StrictMode, act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { RELAY_DEADLINE_MS, useSelectedController } from "./use-selected-controller";
import { JUPITER_BROWSER_ORIGIN, resetJupiterBrowserGate } from "@/lib/jupiter/browser-relay";

// Real facade/relay/storage. Only wallet and HTTP are replaced; keys and time are deterministic.
const wallet = "11111111111111111111111111111111";
const otherWallet = "22222222222222222222222222222222";
const positionMint = "33333333333333333333333333333333";
const inputMint = "44444444444444444444444444444444";
const otherMint = "55555555555555555555555555555555";
const selection = { positionMint, inputMint, inputKind: "token" as const };
const mocks = vi.hoisted(() => ({ address: "11111111111111111111111111111111" as string | undefined, sign: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({
  address: mocks.address, connected: !!mocks.address, signTransaction: mocks.sign,
  connect: () => {}, disconnect: () => {},
}) }));
type Body = Record<string, unknown>;
type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let c: ReturnType<typeof useSelectedController>;
let root: Root;
let mounted: boolean;
let requests: { time: number; url: string; method?: string; body?: string; cache?: RequestCache }[];
let commits: unknown[];
let quoteHandler: Handler;
let prepareHandler: Handler;
let statePatch: Body;
let hidden: boolean;
let writes: ReturnType<typeof vi.spyOn>;
let removes: ReturnType<typeof vi.spyOn>;
let notifications: number;
let added: MockInstance<typeof document.addEventListener>;
let removed: MockInstance<typeof document.removeEventListener>;
const epoch = 1_800_000_000_000;
const body = (init?: RequestInit): Body => JSON.parse(String(init?.body ?? "{}"));
const quote = (b: Body) => ({ ...b, requested: String(Math.round(Number(b.amount) * 1e6)),
  poolId: "pool", positionAccount: "position", liquidity: "100", passesFloor: false,
  expiresAt: Date.now() + 75_000 });
const good: Handler = async (_url, init) => Response.json(quote(body(init)));
const count = (url: string) => requests.filter(r => r.url === url).length;
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function Harness() {
  const current = useSelectedController();
  useEffect(() => {
    c = current;
    commits.push({ time: Date.now() - epoch, wallet: c.wallet ?? null, selection: c.selection, amount: c.amount,
      tolerance: c.tolerancePercent, state: c.state, result: c.result, quote: c.quote, now: c.now,
      error: c.error, quoteError: c.quoteError, code: c.quoteErrorCode, outputMint: c.quoteErrorOutputMint,
      recalculate: c.showQuoteRecalculate, busy: c.busy, calculating: c.calculating,
      fresh: c.fresh, disabled: c.actionDisabled, action: c.actionLabel, status: c.status,
      attempt: c.attempt, attemptStatus: c.attemptStatus, history: c.history, warning: c.historyWarning,
      loadingDiscovery: c.loadingDiscovery, loadingState: c.loadingState });
  });
  return null;
}
const render = () => root.render(<StrictMode><Harness /></StrictMode>);
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function input(value = "1") { await act(async () => c.changeAmount(value)); }
async function fresh(value = "1") { await input(value); await advance(450); expect(c.actionDisabled).toBe(false); }
async function settle() { await advance(10); await advance(10); }
async function retry() { quoteHandler = good; await act(async () => c.retryCalculation()); await advance(450); expect(c.actionDisabled).toBe(false); }
function pure() {
  expect(count("/api/selected-prepare")).toBe(0); expect(count("/api/selected-broadcast")).toBe(0);
  expect(mocks.sign).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(removes).not.toHaveBeenCalled();
  expect(notifications).toBe(0);
}
const historyEvent = () => { notifications++; };
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(epoch); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear(); mocks.address = wallet; mocks.sign.mockReset(); resetJupiterBrowserGate();
  requests = []; commits = []; statePatch = {}; hidden = false; notifications = 0;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  added = vi.spyOn(document, "addEventListener"); removed = vi.spyOn(document, "removeEventListener");
  writes = vi.spyOn(window.localStorage, "setItem"); removes = vi.spyOn(window.localStorage, "removeItem");
  window.addEventListener("sofinance:position-history-refresh", historyEvent);
  quoteHandler = good; prepareHandler = async () => Response.json({ error: "Explicit prepare failed" }, { status: 400 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ time: Date.now() - epoch, url, method: init?.method, body: init?.body as string | undefined, cache: init?.cache });
    const params = new URL(url, "http://fixture.invalid").searchParams;
    if (url.startsWith("/api/wallet?")) return Response.json({ positions: [{ positionMint }, { positionMint: otherMint }],
      assets: [{ kind: "token", mint: inputMint, eligible: true }, { kind: "token", mint: otherMint, eligible: true }] });
    if (url.startsWith("/api/selected-state?")) return Response.json({ wallet: params.get("wallet"), positionMint: params.get("positionMint"),
      inputKind: params.get("inputKind"), inputMint: params.get("inputMint"), inputDecimals: 6, inputBalance: "10000000",
      ownsNft: true, sufficientSol: true, unsupportedExtensions: [], ...statePatch });
    if (url === "/api/selected-quote" || url.startsWith(JUPITER_BROWSER_ORIGIN + "/")) return quoteHandler(url, init);
    if (url === "/api/selected-prepare") return prepareHandler(url, init);
    throw new Error(`Unexpected HTTP boundary: ${url}`);
  }));
  root = createRoot(document.createElement("div")); mounted = true;
  await act(async () => render()); await settle();
});
afterEach(async context => {
  if (mounted) await act(async () => root.unmount());
  // eslint-disable-next-line no-console -- Raw preservation ledger.
  console.log("SELECTED_PREVIEW_LEDGER " + JSON.stringify({ name: context.task.name, requests, commits,
    effects: { writes: writes.mock.calls, removes: removes.mock.calls, sign: mocks.sign.mock.calls.length,
      notify: notifications, timersAfterUnmount: vi.getTimerCount(),
      visibilityAdds: added.mock.calls.filter(([name]) => name === "visibilitychange").length,
      visibilityRemoves: removed.mock.calls.filter(([name]) => name === "visibilitychange").length } }));
  window.removeEventListener("sofinance:position-history-refresh", historyEvent);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("exact 449/450 debounce, latest raw amount/body, informational passesFloor and no automatic effects", async () => {
  await input("1"); await advance(200); await input("2.00"); await advance(449);
  expect(count("/api/selected-quote")).toBe(0); expect(c.calculating).toBe(true); expect(c.actionDisabled).toBe(true);
  await advance(1);
  expect(requests.filter(r => r.url === "/api/selected-quote")).toEqual([{ time: 670, url: "/api/selected-quote", method: "POST", cache: "no-store",
    body: JSON.stringify({ wallet, ...selection, amount: "2.00", floorBps: 9900, toleranceBps: 100 }) }]);
  expect(c.quote?.requested).toBe("2000000"); expect(c.quote?.passesFloor).toBe(false); expect(c.result?.simulated).toBe(false);
  expect(c.actionDisabled).toBe(false); expect(c.status).toBe("Preview ready. Final checks run when you add liquidity."); pure();
});

it.each(["success", "error", "reject"] as const)("stale %s and finally cannot replace the latest loading request across input ABA", async outcome => {
  const old = deferred<Response>(); const latest = deferred<Response>(); let oldBody!: Body;
  quoteHandler = async (_url, init) => { oldBody = body(init); return old.promise; };
  await input(); await advance(450);
  await input("2"); await input("1"); quoteHandler = () => latest.promise; await advance(450);
  await act(async () => { if (outcome === "reject") old.reject(new Error("stale error")); else old.resolve(outcome === "success"
    ? Response.json(quote(oldBody)) : Response.json({ error: "stale error", code: "old", outputMint: otherMint }, { status: 400 })); });
  expect(c.quoteError).toBe(""); expect(c.result).toBeNull(); expect(c.calculating).toBe(true); expect(c.actionDisabled).toBe(true);
  await act(async () => latest.resolve(Response.json(quote(oldBody))));
  expect(c.actionDisabled).toBe(false); expect(c.quote?.requested).toBe("1000000"); pure();
});

it.each(["amount", "tolerance"] as const)("C1: batched %s ABA schedules one fresh quote and fences the old response", async field => {
  const old = deferred<Response>(); let oldBody!: Body;
  quoteHandler = async (_url, init) => { oldBody = body(init); return old.promise; };
  await input(); await advance(450);
  await act(async () => {
    if (field === "amount") { c.changeAmount("2"); c.changeAmount("1"); }
    else { c.changeTolerance("0.5"); c.changeTolerance("1.0"); }
  });
  quoteHandler = good;
  await act(async () => old.resolve(Response.json({ ...quote(oldBody), liquidity: "999" })));
  expect(c.result).toBeNull(); expect(c.actionDisabled).toBe(true);
  await advance(449); expect(count("/api/selected-quote")).toBe(1);
  await advance(1); expect(count("/api/selected-quote")).toBe(2);
  expect(c.quote?.liquidity).toBe("100"); expect(c.quoteError).toBe(""); expect(c.actionDisabled).toBe(false);
  await advance(1000); expect(count("/api/selected-quote")).toBe(2); pure();
});

it.each(["wallet", "selection", "asset"] as const)("stale success/error is fenced across %s ABA and subsequent liveness", async identity => {
  const old = deferred<Response>(); let b!: Body;
  quoteHandler = async (_url, init) => { b = body(init); return old.promise; }; await input(); await advance(450);
  if (identity === "wallet") { mocks.address = otherWallet; await act(async () => render()); await settle(); mocks.address = wallet; await act(async () => render()); }
  else if (identity === "selection") { await act(async () => c.choosePosition(otherMint)); await settle(); await act(async () => c.choosePosition(positionMint)); }
  else { await act(async () => c.chooseAsset("token", otherMint)); await settle(); await act(async () => c.chooseAsset("token", inputMint)); }
  await settle(); quoteHandler = good; await fresh("2");
  await act(async () => old.resolve(Response.json(quote(b))));
  expect(c.quote?.requested).toBe("2000000"); expect(c.quoteError).toBe(""); expect(c.actionDisabled).toBe(false); pure();
});

it.each(["wallet", "positionMint", "inputMint", "inputKind", "requested", "floorBps", "toleranceBps"] as const)("rejects wrong quote %s, then accepts a healthy exact response", async field => {
  quoteHandler = async (_url, init) => Response.json({ ...quote(body(init)), [field]: field === "floorBps" || field === "toleranceBps" ? 7 : "wrong" });
  await input(); await advance(450);
  expect(c.quoteError).toBe("Quote and current input mismatch, please re-enter amount"); expect(c.result).toBeNull();
  expect(c.showQuoteRecalculate).toBe(true); expect(c.actionDisabled).toBe(true); await retry(); pure();
});

it.each(["bad json", "transport", "null", "string throw"])("malformed/error %s remains retryable", async failure => {
  quoteHandler = async () => {
    if (failure === "transport") throw new Error("Transport failure");
    if (failure === "string throw") throw "boundary failure";
    return failure === "null" ? Response.json(null) : new Response("not json");
  };
  await input(); await advance(450); expect(c.quoteError).not.toBe(""); expect(c.showQuoteRecalculate).toBe(true);
  expect(c.actionDisabled).toBe(true); await retry(); pure();
});

it.each([["jupiter_no_route", false], ["amount_too_small", false], ["upstream", true]] as const)("error metadata and Recalculate for %s", async (code, recalculate) => {
  quoteHandler = async () => Response.json({ error: "Exact preview error", code, outputMint: otherMint }, { status: 400 });
  await input(); await advance(450);
  expect([c.error, c.status, c.quoteError, c.quoteErrorCode, c.quoteErrorOutputMint, c.showQuoteRecalculate])
    .toEqual(["Exact preview error", "Exact preview error", "Exact preview error", code, otherMint, recalculate]);
  await retry(); expect(c.quoteErrorCode).toBe(""); expect(c.quoteErrorOutputMint).toBe(""); pure();
});

it("20s deadline is independent of debounce; exact timeout and healthy explicit retry", async () => {
  let signal!: AbortSignal;
  quoteHandler = (_url, init) => new Promise((_yes, no) => { signal = init!.signal!; signal.addEventListener("abort", () => no(signal.reason), { once: true }); });
  await input(); await advance(449); expect(count("/api/selected-quote")).toBe(0); await advance(1);
  await advance(RELAY_DEADLINE_MS - 1); expect(signal.aborted).toBe(false); expect(c.calculating).toBe(true);
  await advance(1); expect(signal.aborted).toBe(true); expect(c.quoteError).toBe("Preview took too long. Please retry.");
  expect(c.showQuoteRecalculate).toBe(true); expect(c.calculating).toBe(false); await retry(); pure();
});

it.each(["", "0", "-1", "wat", "1.0000001", "11"])("invalid or unaffordable amount %s does not quote and recovers", async value => {
  await input(value); await advance(1000); expect(count("/api/selected-quote")).toBe(0); expect(c.actionDisabled).toBe(true);
  await fresh(); pure();
});
it.each([{ ownsNft: false }, { paused: true }, { frozen: true }, { transferFee: true }, { sufficientSol: false }, { unsupportedExtensions: ["unsupported"] }])(
  "not-ready state %j does not quote and recovers", async patch => {
    statePatch = patch; await act(async () => { await c.refreshState(); }); await input(); await advance(500);
    expect(count("/api/selected-quote")).toBe(0); expect(c.actionDisabled).toBe(true);
    statePatch = {}; await act(async () => { await c.refreshState(); }); await advance(450); expect(c.actionDisabled).toBe(false); pure();
  });
it("invalid tolerance and disconnected wallet recover; input changes clear all quote metadata synchronously", async () => {
  await fresh(); await act(async () => c.changeTolerance("5.1")); await advance(500);
  expect(count("/api/selected-quote")).toBe(1); expect(c.status).toContain("Price tolerance");
  await act(async () => c.changeTolerance("0.5")); await advance(450); expect(c.quote?.toleranceBps).toBe(50);
  mocks.address = undefined; await act(async () => render()); await settle(); await input(); await advance(500);
  expect(c.actionDisabled).toBe(true); expect(c.status).toBe("Please connect wallet first");
  mocks.address = wallet; await act(async () => render()); await settle(); await fresh(); pure();
});

it("expiry minimum 1s, expired action disabled, hidden refresh waits for visibility and removes listener", async () => {
  quoteHandler = async (_url, init) => Response.json({ ...quote(body(init)), expiresAt: Date.now() - 1 });
  await input(); await advance(450); expect(c.fresh).toBe(false); expect(c.actionDisabled).toBe(true);
  hidden = true; await advance(999); expect(count("/api/selected-quote")).toBe(1);
  await advance(1); expect(added.mock.calls.filter(([n]) => n === "visibilitychange")).toHaveLength(1);
  await advance(5000); expect(count("/api/selected-quote")).toBe(1);
  await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await advance(500);
  expect(count("/api/selected-quote")).toBe(1);
  quoteHandler = good; hidden = false; await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(removed.mock.calls.filter(([n]) => n === "visibilitychange")).toHaveLength(1);
  await advance(449); expect(count("/api/selected-quote")).toBe(1); await advance(1); expect(c.actionDisabled).toBe(false); pure();
});

it("visible expiry refreshes with original deadline and 450ms debounce", async () => {
  quoteHandler = async (_url, init) => Response.json({ ...quote(body(init)), expiresAt: Date.now() + 2000 });
  await fresh(); await advance(1999); expect(count("/api/selected-quote")).toBe(1);
  await advance(1); quoteHandler = good; await advance(449); expect(count("/api/selected-quote")).toBe(1);
  await advance(1); expect(count("/api/selected-quote")).toBe(2); expect(c.actionDisabled).toBe(false); pure();
});

it("same selection object churn retains reset timing; callback/provider rerenders do not restart debounce", async () => {
  await input(); await advance(200); await act(async () => render()); await advance(249);
  expect(count("/api/selected-quote")).toBe(0); await advance(1); expect(c.actionDisabled).toBe(false);
  await act(async () => c.choosePosition(positionMint)); expect(c.amount).toBe("1"); await advance(1);
  expect(c.amount).toBe(""); expect(c.result).toBeNull(); await fresh("2"); pure();
});

it("busy pauses quoting; prepare failure resumes preview and submission error wins display priority", async () => {
  await fresh(); const prepare = deferred<Response>(); prepareHandler = () => prepare.promise;
  await act(async () => c.primaryAction()); expect(c.busy).toBe(true);
  await advance(2000); expect(count("/api/selected-quote")).toBe(1);
  await act(async () => prepare.resolve(Response.json({ error: "Submit error" }, { status: 400 })));
  expect(c.busy).toBe(false); quoteHandler = async () => Response.json({ error: "Quote error", code: "upstream", outputMint: otherMint }, { status: 400 });
  await advance(450); expect(c.error).toBe("Submit error"); expect(c.quoteError).toBe("Quote error"); expect(c.status).toBe("Quote error");
  await retry(); expect(c.error).toBe("Submit error"); await input("2"); expect(c.error).toBe(""); await advance(450);
  expect(c.actionDisabled).toBe(false); expect(count("/api/selected-prepare")).toBe(1);
  expect(mocks.sign).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
});

it.each(["pending", "debounce", "visibility"])("unmount cleans %s resources and blocks stale callbacks; remount works", async phase => {
  const wait = deferred<Response>(); let signal: AbortSignal | null = null;
  quoteHandler = async (_url, init) => { signal = init!.signal!; return phase === "visibility"
    ? Response.json({ ...quote(body(init)), expiresAt: Date.now() }) : wait.promise; };
  await input(); if (phase !== "debounce") await advance(450); if (phase === "visibility") { hidden = true; await advance(1000); }
  const before = requests.length;
  await act(async () => root.unmount()); mounted = false;
  if (signal) expect((signal as AbortSignal).aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  if (phase === "pending") await act(async () => wait.reject(new Error("late rejection")));
  hidden = false; await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await advance(25_000);
  expect(requests).toHaveLength(before); pure();
  quoteHandler = good; root = createRoot(document.createElement("div")); mounted = true;
  await act(async () => render()); await settle(); await fresh(); pure();
});

it("Activity reconnect fences old quote and requires a live new quote", async () => {
  const view = (mode: "visible" | "hidden") => root.render(<StrictMode><Activity mode={mode}><Harness /></Activity></StrictMode>);
  await act(async () => view("visible")); await settle(); const wait = deferred<Response>(); let b!: Body;
  quoteHandler = async (_url, init) => { b = body(init); return wait.promise; }; await input(); await advance(450);
  await act(async () => view("hidden")); await act(async () => wait.resolve(Response.json(quote(b))));
  quoteHandler = good; await act(async () => view("visible")); await settle(); await fresh("2");
  expect(c.quote?.requested).toBe("2000000"); pure();
});

it.each([1000, 1005])("panel relay cache is shared by explicit prepare at near amount %s", async amount => {
  const url = (n: number) => `/swap/v1/quote?inputMint=${inputMint}&outputMint=${otherMint}&amount=${n}`;
  const need = (n: number) => ({ id: `quote-${n}`, method: "GET", url: url(n) });
  quoteHandler = async (path, init) => {
    if (path.startsWith(JUPITER_BROWSER_ORIGIN + "/")) return Response.json({ inAmount: "1000", outAmount: "900" });
    const b = body(init); const relay = b.jupiterRelay as { responses: Body } | undefined;
    if (!relay?.responses["quote-1000"]) return Response.json({ code: "jupiter_relay_needed", needs: [need(1000)] }, { status: 409 });
    return Response.json(quote(b));
  };
  prepareHandler = async (_url, init) => {
    const relay = body(init).jupiterRelay as { responses: Body; hints: Body } | undefined;
    if (!relay) return Response.json({ code: "jupiter_relay_needed", needs: [need(amount)] }, { status: 409 });
    expect(relay.responses["quote-1000"]).toEqual({ status: 200, body: { inAmount: "1000", outAmount: "900" }, retryAfterMs: null });
    if (amount !== 1000 && relay.hints.spend !== "1000") return Response.json({ code: "jupiter_relay_needed", needs: [need(amount)], hints: { spend: String(amount) } }, { status: 409 });
    return Response.json({ error: "Stopped at HTTP prepare boundary" }, { status: 400 });
  };
  await fresh(); expect(requests.filter(r => r.url.startsWith(JUPITER_BROWSER_ORIGIN + "/"))).toHaveLength(1);
  await act(async () => c.primaryAction()); expect(c.error).toBe("Stopped at HTTP prepare boundary");
  expect(requests.filter(r => r.url.startsWith(JUPITER_BROWSER_ORIGIN + "/"))).toHaveLength(1);
  expect(count("/api/selected-prepare")).toBe(amount === 1000 ? 2 : 3);
  expect(mocks.sign).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(count("/api/selected-broadcast")).toBe(0);
});

// Resolve before React flushes effect cleanup: the input command itself must revoke ownership.
it.each(["amount", "tolerance"] as const)("%s invalidates an outstanding error synchronously before passive cleanup", async field => {
  const old = deferred<Response>(); quoteHandler = () => old.promise;
  await input(); await advance(450);
  await act(async () => {
    if (field === "amount") c.changeAmount("2"); else c.changeTolerance("0.5");
    old.reject(new Error("must not commit during input command"));
    await old.promise.catch(() => undefined);
  });
  expect(c.quoteError).toBe(""); expect(c.quoteErrorCode).toBe("");
  quoteHandler = good; await advance(450); expect(c.actionDisabled).toBe(false); pure();
});
it.each(["wallet", "selection"] as const)("late %s error after reset cannot repopulate quote errors", async identity => {
  const old = deferred<Response>(); quoteHandler = () => old.promise;
  await input(); await advance(450);
  if (identity === "wallet") { mocks.address = otherWallet; await act(async () => render()); }
  else await act(async () => c.choosePosition(otherMint));
  await settle(); await act(async () => old.resolve(Response.json({error:"old quote", code:"old", outputMint:otherMint}, {status:400})));
  expect(c.quoteError).toBe(""); quoteHandler = good; await fresh(); pure();
});
