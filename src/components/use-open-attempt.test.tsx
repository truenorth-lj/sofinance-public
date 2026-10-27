// @vitest-environment happy-dom
import { Activity, StrictMode, Suspense, act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { useOpenAttempt } from "./use-open-attempt";
import { openAttemptKey, type OpenAttempt } from "@/lib/open-attempt";
import { testKeypair } from "@/lib/test-support/send-fixtures";

const walletA = testKeypair(1).publicKey.toBase58(), walletB = testKeypair(3).publicKey.toBase58();
const attempt = (seed = 4, wallet = walletA): OpenAttempt => ({ version: 1, wallet,
  signature: bs58.encode(new Uint8Array(64).fill(seed)), nftMint: testKeypair(2).publicKey.toBase58(),
  positionAccount: testKeypair(5).publicKey.toBase58(), poolId: testKeypair(6).publicKey.toBase58(),
  tickLower: -60, tickUpper: 60, liquidity: "100", blockhash: testKeypair(7).publicKey.toBase58(),
  lastValidBlockHeight: 150, createdAt: 1700000000000 });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let root: Root, container: HTMLDivElement, api: ReturnType<typeof useOpenAttempt>;
let wallet: string | undefined, hidden: boolean, suspended: boolean, strict: boolean;
let hold: ReturnType<typeof deferred<void>>;
let ledger: unknown[], storage: Storage, failRead: boolean, failWrite: "throw" | "drop" | null;
let respond: (body: { attempt: OpenAttempt }) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
const record = (...event: unknown[]) => ledger.push([Date.now(), ...event]);
function Probe() {
  const value = useOpenAttempt(wallet);
  useLayoutEffect(() => { api = value; const { attempt, status, error, pending, loaded } = value;
    record("commit", { attempt, status, error, pending, loaded }); });
  if (suspended) throw hold.promise;
  return null;
}
async function render() { await act(async () => root.render(createElement(strict ? StrictMode : "div", null,
  <Activity mode={hidden ? "hidden" : "visible"}><Suspense fallback="loading"><Probe /></Suspense></Activity>))); }
async function advance(ms = 1) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function mount(saved?: OpenAttempt) { if (saved) storage.setItem(openAttemptKey(saved.wallet), JSON.stringify(saved)); await render(); await advance(); }
async function settle(status: string, signature = api.attempt!.signature) {
  respond = async () => Response.json({ signature, status }); await act(async () => api.retry());
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  wallet = walletA; hidden = suspended = strict = false; hold = deferred<void>(); ledger = [];
  failRead = false; failWrite = null; storage = window.localStorage; storage.clear();
  vi.spyOn(window, "localStorage", "get").mockReturnValue({
    getItem: (key: string) => { record("get", key); if (failRead) throw new Error("storage read failed"); return storage.getItem(key); },
    setItem: (key: string, value: string) => { record("set", key, value); if (failWrite === "throw") throw new Error("storage write failed"); if (failWrite !== "drop") storage.setItem(key, value); },
    removeItem: (key: string) => { record("remove", key); storage.removeItem(key); },
  } as Storage);
  respond = async body => Response.json({ signature: body.attempt.signature, status: "pending" });
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("/api/open-status"); record("fetch", url, init.body, init.method, init.cache);
    init.signal?.addEventListener("abort", () => record("abort", init.signal?.reason?.name), { once: true });
    return respond(JSON.parse(String(init.body)));
  }); vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async context => {
  await act(async () => { hold.resolve(); root.unmount(); }); container.remove();
  record("storage", Object.fromEntries(Object.keys(storage).sort().map(k => [k, storage.getItem(k)])));
  record("timers", vi.getTimerCount()); expect(vi.getTimerCount()).toBe(0);
  // eslint-disable-next-line no-console -- Raw before/after characterization evidence.
  console.log("OPEN_LEDGER " + JSON.stringify({ name: context.task.name, ledger }));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
describe("Open attempt accepted lifecycle", () => {
  it("loads on timer zero, polls on zero then 3000, and exposes the exact synchronous facade", async () => {
    storage.setItem(openAttemptKey(walletA), JSON.stringify(attempt())); await render();
    expect(api.loaded).toBe(false); expect(api.pending).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    expect(Object.keys(api)).toEqual(["attempt", "status", "error", "pending", "loaded", "track", "markUnsent", "dismissTerminal", "retry"]);
    await advance(0); expect(api.loaded).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
    await advance(0); expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(2999); expect(fetchMock).toHaveBeenCalledTimes(1); await advance(1); expect(fetchMock).toHaveBeenCalledTimes(2);
    const old = api; await render(); for (const key of ["track", "markUnsent", "dismissTerminal", "retry"] as const) expect(api[key]).not.toBe(old[key]);
  });
  it.each(["empty", "invalid", "unavailable"])("loads %s history without deleting it", async mode => {
    if (mode === "invalid") storage.setItem(openAttemptKey(walletA), "broken"); failRead = mode === "unavailable";
    await mount(); expect(api.loaded).toBe(true); expect(api.pending).toBe(mode !== "empty");
    expect(api.status).toBe(mode === "empty" ? null : "manual-review");
    if (mode !== "empty") expect(api.error).toContain(mode === "invalid" ? "cannot be verified" : "Unable to read");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("without wallet projects loaded and unlocked even with retained history", async () => {
    await mount(attempt()); wallet = undefined; await render(); expect(api).toMatchObject({ loaded: true, pending: false, attempt: null, error: "", status: null });
  });
  it.each(["confirmed", "failed", "expired", "manual-review"])("observes %s and retains original bytes through dismissal and retry", async status => {
    await mount(attempt()); await settle(status);
    expect(api.status).toBe(status); expect(api.pending).toBe(status === "manual-review");
    const before = api.attempt; const raw = storage.getItem(openAttemptKey(walletA));
    await act(async () => api.dismissTerminal()); expect(api.attempt).toBe(before);
    expect(api.status).toBe(status === "manual-review" ? status : null); expect(storage.getItem(openAttemptKey(walletA))).toBe(raw);
    await settle("confirmed"); expect(api.status).toBe("confirmed");
  });
  it.each(["wrong-signature", "unknown-status", "unsent", "http", "parse", "non-error"])("rejects %s with original signature intact then recovers", async mode => {
    await mount(attempt()); respond = async () => {
      if (mode === "non-error") throw "transport";
      if (mode === "parse") return { ok: false, json: async () => { throw new Error("bad json"); } } as unknown as Response;
      return Response.json({ signature: mode === "wrong-signature" ? attempt(8).signature : attempt().signature,
        status: mode === "unknown-status" ? "made-up" : mode === "unsent" ? "unsent" : "confirmed", error: "http error" }, { status: mode === "http" ? 503 : 200 });
    };
    await act(async () => api.retry()); expect(api.status).toBe("pending"); expect(api.attempt).toEqual(attempt());
    expect(api.error).toContain(mode === "http" ? "http error" : mode === "parse" ? "bad json" : mode === "non-error" ? "Unable to verify" : "mismatch");
    await settle("expired"); expect(api.status).toBe("expired");
  });
  it("deduplicates overlapping retry/poll through slow JSON and retains the 10000ms signal deadline", async () => {
    await mount(attempt()); const json = deferred<unknown>(); let signal!: AbortSignal;
    const deadline = new AbortController(); const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    fetchMock.mockImplementationOnce(async (_url, init) => { signal = init.signal; return { ok: true, json: () => json.promise }; });
    await act(async () => api.retry()); const count = fetchMock.mock.calls.length;
    await act(async () => { api.retry(); api.retry(); }); await advance(9999); expect(fetchMock.mock.calls.length).toBe(count); expect(signal.aborted).toBe(false);
    await advance(1); expect(timeout).toHaveBeenCalledWith(10_000); deadline.abort(new DOMException("Timed out", "TimeoutError")); expect(signal.aborted).toBe(true);
    // Baseline current() checks effect signal, not the composed timeout after JSON settles.
    await act(async () => json.resolve({ signature: attempt().signature, status: "confirmed" })); expect(api.status).toBe("confirmed");
  });
  it("functional errors follow queued dismissal; later valid retry still works", async () => {
    await mount(attempt()); await settle("confirmed"); const response = deferred<Response>(); respond = () => response.promise;
    await act(async () => api.retry()); await act(async () => { api.dismissTerminal(); response.reject(new Error("late error")); });
    expect(api.status).toBeNull(); expect(api.error).toBe("late error"); await settle("failed"); expect(api.status).toBe("failed");
  });
  it("retained dismiss replaces a newer tracked render with its captured terminal snapshot", async () => {
    await mount(attempt()); await settle("confirmed"); const dismiss = api.dismissTerminal;
    await act(async () => { api.track(attempt(8)); dismiss(); });
    expect(api.attempt).toEqual(attempt()); expect(api.status).toBeNull();
    expect(storage.getItem(openAttemptKey(walletA))).toBe(JSON.stringify(attempt(8)));
    await act(async () => api.track(attempt(8))); await settle("expired"); expect(api.status).toBe("expired");
  });
  it("old response cannot overwrite a different newly tracked signature", async () => {
    await mount(attempt()); const response = deferred<Response>(); respond = () => response.promise;
    await act(async () => api.retry()); await act(async () => api.track(attempt(8)));
    await act(async () => response.reject(new Error("old error"))); expect(api.error).toBe(""); expect(api.attempt).toEqual(attempt(8));
    await settle("confirmed"); expect(api.status).toBe("confirmed");
  });
  it.each(["throw", "drop"] as const)("storage %s fails synchronously before publication", async fault => {
    await mount(); failWrite = fault; await act(async () => { expect(() => api.track(attempt())).toThrow(); }); expect(api.attempt).toBeNull();
    failWrite = null; await act(async () => { expect(api.track(attempt())).toBeUndefined(); }); expect(api.status).toBe("pending");
  });
  it.each(["throw", "drop"] as const)("unsent archive %s retains the current receipt and lock", async fault => {
    await mount(attempt()); failWrite = fault;
    await act(async () => { expect(() => api.markUnsent(attempt())).toThrow(); });
    expect(api.status).toBe("pending"); expect(storage.getItem(openAttemptKey(walletA))).toBe(JSON.stringify(attempt()));
    failWrite = null; await act(async () => api.markUnsent(attempt())); expect(api.status).toBe("unsent");
  });
  it.each(["throw", "drop"] as const)("unsent remove %s preserves archive and blocks publication", async fault => {
    await mount(attempt()); const remove = vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      if (fault === "throw") throw new Error("remove denied");
    });
    await act(async () => { expect(() => api.markUnsent(attempt())).toThrow(); });
    expect(api.status).toBe("pending"); expect(storage.getItem(openAttemptKey(walletA))).toBe(JSON.stringify(attempt()));
    expect(storage.getItem(openAttemptKey(walletA) + ":unsent:" + attempt().signature)).toBe(JSON.stringify(attempt()));
    remove.mockRestore(); await act(async () => api.markUnsent(attempt())); expect(api.status).toBe("unsent");
  });
  it("archive collision retains exact earlier bytes and uses a suffix", async () => {
    await mount(attempt()); const key = openAttemptKey(walletA) + ":history:" + attempt().signature;
    storage.setItem(key, "earlier raw record"); await act(async () => api.track(attempt(8)));
    expect(storage.getItem(key)).toBe("earlier raw record"); expect(storage.getItem(key + ":1")).toBe(JSON.stringify(attempt()));
    expect(api.attempt).toEqual(attempt(8));
  });
  it("same-signature queued track keeps functional error on the latest state", async () => {
    await mount(attempt()); const result = deferred<Response>(); respond = () => result.promise;
    await act(async () => api.retry());
    await act(async () => { api.track(attempt()); result.reject(new Error("late same-owner error")); });
    expect(api).toMatchObject({ status: "pending", error: "late same-owner error" });
    await settle("confirmed"); expect(api.status).toBe("confirmed");
  });
  it("track before load updates its synchronous owner before the load timer", async () => {
    await render(); await act(async () => { api.track(attempt()); api.track(attempt(8)); }); await advance();
    expect(api.attempt).toEqual(attempt(8)); expect(storage.getItem(openAttemptKey(walletA) + ":history:" + attempt().signature)).toBe(JSON.stringify(attempt()));
  });
  it("other-tab changes block synchronous track but valid current owner remains usable", async () => {
    await mount(attempt()); storage.setItem(openAttemptKey(walletA), JSON.stringify(attempt(8)));
    expect(() => api.track(attempt(9))).toThrow("history changed"); expect(api.attempt).toEqual(attempt());
    storage.setItem(openAttemptKey(walletA), JSON.stringify(attempt())); await act(async () => api.track(attempt(9))); expect(api.attempt).toEqual(attempt(9));
  });
  it("markUnsent archives before checking currentness even after unmount", async () => {
    await mount(attempt()); const stale = api; await act(async () => root.unmount()); root = createRoot(container);
    expect(stale.markUnsent(attempt())).toBeUndefined(); expect(storage.getItem(openAttemptKey(walletA))).toBeNull();
    expect(storage.getItem(openAttemptKey(walletA) + ":unsent:" + attempt().signature)).toBe(JSON.stringify(attempt()));
    expect(() => stale.track(attempt())).toThrow("changed"); await mount(); expect(api.pending).toBe(false);
  });
  it("unsent retains attempt and clears synchronous signature ownership; retry result is ignored", async () => {
    await mount(attempt()); await act(async () => api.markUnsent(attempt())); expect(api).toMatchObject({ attempt: attempt(), status: "unsent", pending: false });
    await settle("confirmed"); expect(api.status).toBe("unsent"); await act(async () => api.track(attempt(8))); await settle("confirmed"); expect(api.status).toBe("confirmed");
  });
  it("wallet A-B-A filters old views and preserves baseline manual retry ABA acceptance", async () => {
    await mount(attempt()); const result = deferred<Response>(); respond = () => result.promise;
    await act(async () => api.retry()); wallet = walletB; await render(); expect(api.loaded).toBe(false); await advance(); expect(api.pending).toBe(false);
    wallet = walletA; await render(); await advance(); await act(async () => result.resolve(Response.json({ signature: attempt().signature, status: "expired" })));
    expect(api.status).toBe("expired"); await settle("confirmed"); expect(api.status).toBe("confirmed");
  });
  it.each(["unmount", "activity", "suspense", "strict"])("preserves %s cleanup and fresh liveness", async mode => {
    strict = mode === "strict"; await mount(attempt()); const result = deferred<Response>(); respond = () => result.promise;
    await act(async () => api.retry()); const retained = api;
    if (mode === "unmount") { await act(async () => root.unmount()); root = createRoot(container); }
    else if (mode === "activity") { hidden = true; await render(); }
    else if (mode === "suspense") { suspended = true; await render(); }
    if (mode !== "strict") expect(() => retained.track(attempt(8))).toThrow("changed");
    await act(async () => result.resolve(Response.json({ signature: attempt().signature, status: "confirmed" })));
    hidden = suspended = false; await act(async () => hold.resolve()); await render(); await advance();
    await settle("expired");
    // Suspense reconnect replays the wallet layout effect (clears owner), but not history load.
    if (mode === "suspense") { expect(api.status).toBe("pending"); expect(() => api.track(attempt(8))).toThrow("history changed");
      await act(async () => root.unmount()); root = createRoot(container); await mount(); await settle("expired"); }
    expect(api.status).toBe("expired");
  });
});
