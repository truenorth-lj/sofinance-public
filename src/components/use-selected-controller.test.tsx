// @vitest-environment happy-dom
import { act, Activity, createElement, StrictMode, Suspense, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { RELAY_DEADLINE_MS, useSelectedController } from "./use-selected-controller";
import { persistSelectedAttempt, selectedAttemptKey, type SelectedAttempt } from "@/lib/selected-attempt";
import { appendWalletExtraInstruction } from "@/lib/test-support/send-fixtures";

const mocks = vi.hoisted(() => ({ sign: vi.fn(), address: "11111111111111111111111111111111" as string | undefined }));
const wallet = "11111111111111111111111111111111";
let keySeed = 10;
const key = () => new PublicKey(new Uint8Array(32).fill(keySeed++)).toBase58();
const selection = { positionMint: key(), inputMint: key(), inputKind: "token" as const };
const poolId = key();
const positionAccount = key();
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({
  address: mocks.address, connected: Boolean(mocks.address), signTransaction: mocks.sign,
}) }));
let controller: ReturnType<typeof useSelectedController>;
let root: Root;
let prepareError: boolean;
let tweakPrepared: (value: ReturnType<typeof prepared>) => void;
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
// Capture native methods once: happy-dom Storage proxies can retain a spy wrapper
// between tests, so recapturing a method per test would nest ledger observers.
const nativeStorage = Object.fromEntries(["getItem", "setItem", "removeItem", "key"].map(method =>
  [method, (window.localStorage[method as "getItem"] as (...args: string[]) => unknown).bind(window.localStorage)]));
let ledger: unknown[];
const record = (kind: string, data: unknown) => ledger.push({ at: Date.now(), kind, data });
const notification = (event: Event) => record("notify", (event as CustomEvent).detail);
function Harness() {
  const current = useSelectedController();
  useEffect(() => { controller = current; record("commit", Object.fromEntries(Object.entries(current).filter(([, value]) => typeof value !== "function"))); });
  return null;
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const calls = (url: string) => fetchMock.mock.calls.filter(([input]) => input === url);
function quote(body: Record<string, unknown>) {
  return { wallet, ...selection, poolId, positionAccount, requested: String(Math.round(Number(body.amount) * 1e9)),
    floorBps: body.floorBps, toleranceBps: body.toleranceBps, passesFloor: false, liquidity: "100",
    roundtripCostInput: null, expiresAt: Date.now() + 75000 };
}
function prepared(body: Record<string, unknown>) {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: new PublicKey(wallet), recentBlockhash: wallet, instructions: [],
  }).compileToV0Message());
  const value = { quote: quote(body), simulated: true, permit: "permit", startingLiquidity: "1", lastValidBlockHeight: 100,
    startingBalances: { input: "1000000000", a: "0", b: "0" },
    expiresAt: Date.now() + 75000, blockhash: wallet,
    unsignedTransaction: btoa(String.fromCharCode(...transaction.serialize())) };
  return value;
}
async function ready() {
  await act(async () => controller.changeAmount("0.01")); await advance(500);
  expect(controller.actionDisabled).toBe(false);
}
function stallUntilAbort(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}
const signNormally = () => mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
  tx.signatures[0] = new Uint8Array(64).fill(1); return tx;
});
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); keySeed = 30; ledger = [];
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  window.addEventListener("sofinance:position-history-refresh", notification);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear(); prepareError = false; tweakPrepared = () => {};
  mocks.address = wallet; mocks.sign.mockReset().mockRejectedValue(new Error("Wallet reached"));
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/wallet?")) return Response.json({
      positions: [{ positionMint: selection.positionMint }], assets: [{ kind: "token", mint: selection.inputMint, eligible: true }],
    });
    if (url.startsWith("/api/selected-state?")) return Response.json({
      wallet, ...selection, inputDecimals: 9, inputBalance: "1000000000",
      ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
    });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url === "/api/selected-quote") return Response.json(quote(body));
    if (url === "/api/selected-prepare") {
      if (prepareError) return Response.json({ error: "Simulation failed" }, { status: 400 });
      const value = prepared(body); tweakPrepared(value); return Response.json(value);
    }
    if (url === "/api/selected-broadcast") return Response.json({ signature: bs58.encode(new Uint8Array(64).fill(1)) });
    if (url === "/api/selected-status") return Response.json({ status: "pending", state: null, signature: body.signature });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    record("request", { url, method: init?.method, body: init?.body, cache: init?.cache });
    return fetchMock(url, init);
  });
  const storage = window.localStorage;
  for (const method of ["getItem", "setItem", "removeItem", "key"] as const) {
    const original = nativeStorage[method]!;
    vi.spyOn(storage, method).mockImplementation(((...args: string[]) => {
      const value = original(...args); record(method, { args, value }); return value;
    }) as never);
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness))); await advance(30); await advance(30); await advance(30);
});
afterEach(async context => {
  await act(async () => root.unmount());
  const storage = storageContents();
  // eslint-disable-next-line no-console -- Frozen accepted-runtime preservation evidence.
  console.log("SELECTED_ATTEMPT_LEDGER " + JSON.stringify({ name: context.task.name, ledger, storage,
    sign: mocks.sign.mock.calls.length, timersAfterUnmount: vi.getTimerCount() }));
  window.removeEventListener("sofinance:position-history-refresh", notification);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it("prompts to pick another asset when selected-state reports input_asset_not_held", async () => {
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url.startsWith("/api/selected-state?")
    ? Response.json({
      error: "Wallet does not have the selected investable asset",
      code: "input_asset_not_held",
    }, { status: 409 })
    : handler(url, init));
  await act(async () => { await controller.refreshState(); });
  expect(controller.state).toBeNull();
  expect(controller.stateError).toBe("Wallet does not have the selected input asset. Please pick another asset.");
  expect(controller.status).toBe("Wallet does not have the selected input asset. Please pick another asset.");
  expect(controller.actionDisabled).toBe(true);
});

it.each(["wallet", "positionMint", "inputMint", "inputKind"] as const)("hides selected-state with mismatched %s", async (field) => {
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await handler(url, init);
    if (!url.startsWith("/api/selected-state?")) return response;
    return Response.json({ ...await response.json(), [field]: field === "inputKind" ? "native" : key() });
  });
  await act(async () => { await controller.refreshState(); });
  expect(controller.state).toBeNull();
  expect(controller.status).toBe("Verifying selected position");
  expect(controller.actionDisabled).toBe(true);
  expect(calls("/api/selected-quote")).toHaveLength(0);
  expect(mocks.sign).not.toHaveBeenCalled();
});

it("hides the old state immediately on selection change and ignores its late response", async () => {
  const handler = fetchMock.getMockImplementation()!;
  let release!: (response: Response) => void;
  const late = new Promise<Response>(resolve => { release = resolve; });
  fetchMock.mockImplementationOnce(() => late);
  let refresh!: Promise<void>;
  await act(async () => { refresh = controller.refreshState(); });
  const nextMint = key();
  await act(async () => controller.choosePosition(nextMint));
  expect(controller.state).toBeNull();
  fetchMock.mockImplementation(async (url, init) => {
    const response = await handler(url, init);
    return url.startsWith("/api/selected-state?")
      ? Response.json({ ...await response.json(), positionMint: nextMint }) : response;
  });
  await advance(30);
  expect(controller.state?.positionMint).toBe(nextMint);
  await act(async () => {
    release(await handler("/api/selected-state?"));
    await refresh;
  });
  expect(controller.state?.positionMint).toBe(nextMint);
  expect(controller.amount).toBe("");
  expect(calls("/api/selected-quote")).toHaveLength(0);
  expect(mocks.sign).not.toHaveBeenCalled();
});

it("shows a lightweight preview and only prepares after Add, regardless of resale advice", async () => {
  await ready();
  expect(calls("/api/selected-quote")).toHaveLength(1);
  expect(calls("/api/selected-preflight")).toHaveLength(0);
  expect(calls("/api/selected-prepare")).toHaveLength(0);
  expect(controller.quote?.passesFloor).toBe(false);
  expect(controller.result?.simulated).toBe(false);
  expect(controller.status).toContain("Preview ready");
  await act(async () => controller.primaryAction());
  expect(calls("/api/selected-prepare")).toHaveLength(1);
  expect(mocks.sign).toHaveBeenCalledOnce();
  expect(controller.error).toBe("Wallet reached");
});
it("does not call the wallet or broadcast when prepare simulation fails", async () => {
  await ready(); prepareError = true;
  await act(async () => controller.primaryAction());
  expect(controller.error).toBe("Simulation failed");
  expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/selected-broadcast")).toHaveLength(0);
});
it("debounces input changes into one preview of the last amount", async () => {
  await act(async () => controller.changeAmount("0.01")); await advance(200);
  await act(async () => controller.changeAmount("0.02")); await advance(500);
  expect(calls("/api/selected-quote")).toHaveLength(1);
  expect(controller.quote?.requested).toBe("20000000");
});
it("ignores a late preview after the amount changes", async () => {
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce((_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    return new Promise<Response>((done) => { resolve = () => done(Response.json(quote(body))); });
  });
  await act(async () => controller.changeAmount("0.01")); await advance(500);
  await act(async () => controller.changeAmount("0.02")); await advance(500);
  await act(async () => resolve(Response.json({})));
  expect(controller.quote?.requested).toBe("20000000");
});
it("ends a stalled preview at the client deadline and offers explicit retry", async () => {
  fetchMock.mockImplementationOnce((_url: string, init: RequestInit = {}) => stallUntilAbort(init.signal as AbortSignal));
  await act(async () => controller.changeAmount("0.01")); await advance(RELAY_DEADLINE_MS + 500);
  expect(controller.quoteError).toBe("Preview took too long. Please retry.");
  expect(controller.showQuoteRecalculate).toBe(true);
  expect(controller.calculating).toBe(false); expect(controller.actionDisabled).toBe(true);
  await act(async () => controller.retryCalculation()); await advance(500);
  expect(controller.quoteError).toBe(""); expect(controller.actionDisabled).toBe(false);
});
it("does not offer Recalculate when Jupiter has no fitting route", async () => {
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/selected-quote"
    ? Response.json({
      error: "No route from SPCX to INTC within the transaction size limit. Try USDC, SOL, or one of the pool's tokens.",
      code: "jupiter_no_route", inputMint: selection.inputMint, outputMint: selection.inputMint,
    }, { status: 400 })
    : handler(url, init));
  await act(async () => controller.changeAmount("0.01")); await advance(500);
  expect(controller.quoteError).toMatch(/No route from SPCX to INTC/);
  expect(controller.quoteErrorCode).toBe("jupiter_no_route");
  expect(controller.showQuoteRecalculate).toBe(false);
  expect(controller.calculating).toBe(false);
});
it("does not offer Recalculate when the amount is too small to swap", async () => {
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/selected-quote"
    ? Response.json({
      error: "Amount too small to swap into this position — try a larger amount",
      code: "amount_too_small",
    }, { status: 400 })
    : handler(url, init));
  await act(async () => controller.changeAmount("0.0011")); await advance(500);
  expect(controller.quoteError).toMatch(/Amount too small/);
  expect(controller.quoteErrorCode).toBe("amount_too_small");
  expect(controller.showQuoteRecalculate).toBe(false);
  expect(controller.calculating).toBe(false);
});
it("ends a stalled prepare before signing and unlocks for retry", async () => {
  await ready();
  fetchMock.mockImplementationOnce((_url: string, init: RequestInit = {}) => stallUntilAbort(init.signal as AbortSignal));
  await act(async () => controller.primaryAction()); await advance(RELAY_DEADLINE_MS);
  expect(controller.error).toBe("Preparation took too long. Please retry.");
  expect(controller.busy).toBe(false); expect(mocks.sign).not.toHaveBeenCalled();
});
it.each(["unsimulated", "missing permit", "wrong amount", "expired"])("refuses invalid prepare: %s", async (mode) => {
  await ready();
  tweakPrepared = (value) => {
    if (mode === "unsimulated") value.simulated = false;
    if (mode === "missing permit") value.permit = "";
    if (mode === "wrong amount") value.quote.requested = "1";
    if (mode === "expired") value.expiresAt = Date.now() - 1;
  };
  await act(async () => controller.primaryAction());
  expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/selected-broadcast")).toHaveLength(0);
});
it("rejects a wallet that mutates the original transaction object in place", async () => {
  await ready();
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
    tx.message.recentBlockhash = key(); tx.signatures[0] = new Uint8Array(64).fill(1); return tx;
  });
  await act(async () => controller.primaryAction());
  expect(controller.error).toContain("Wallet changed the transaction blockhash");
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
});
it("broadcasts when the wallet appends a Lighthouse instruction", async () => {
  await ready();
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
    const extra = appendWalletExtraInstruction(tx);
    extra.signatures[0] = new Uint8Array(64).fill(1);
    return extra;
  });
  await act(async () => controller.primaryAction());
  expect(controller.error).toBe("");
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
});
it("rejects an unsigned wallet response", async () => {
  await ready(); mocks.sign.mockImplementation(async (tx: VersionedTransaction) => tx);
  await act(async () => controller.primaryAction());
  expect(controller.error).toContain("valid signature"); expect(calls("/api/selected-broadcast")).toHaveLength(0);
});
it("does not time out the user's wallet confirmation after prepare completes", async () => {
  await ready();
  let resolve!: (value: VersionedTransaction) => void;
  let unsigned!: VersionedTransaction;
  mocks.sign.mockImplementation((tx: VersionedTransaction) => {
    unsigned = tx; return new Promise<VersionedTransaction>((done) => { resolve = done; });
  });
  await act(async () => controller.primaryAction()); await advance(RELAY_DEADLINE_MS + 1000);
  expect(controller.busy).toBe(true); expect(controller.error).toBe("");
  await act(async () => { unsigned.signatures[0] = new Uint8Array(64).fill(1); resolve(unsigned); });
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
});
it("stops submission if input changes while the wallet is signing", async () => {
  await ready();
  let resolve!: (value: VersionedTransaction) => void;
  let unsigned!: VersionedTransaction;
  mocks.sign.mockImplementation((tx: VersionedTransaction) => {
    unsigned = tx; return new Promise<VersionedTransaction>((done) => { resolve = done; });
  });
  await act(async () => controller.primaryAction());
  await act(async () => controller.changeAmount("0.02"));
  await act(async () => { unsigned.signatures[0] = new Uint8Array(64).fill(1); resolve(unsigned); });
  expect(controller.error).toContain("changed during signing");
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
});
it("prepares and broadcasts only once on a double click, with attempt saved before send", async () => {
  await ready(); signNormally();
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/selected-broadcast") expect(window.localStorage.getItem(selectedAttemptKey(wallet))).not.toBeNull();
    return handler(url, init);
  });
  await act(async () => { controller.primaryAction(); controller.primaryAction(); });
  expect(calls("/api/selected-prepare")).toHaveLength(1);
  expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("/api/selected-broadcast")).toHaveLength(1);
  expect(controller.attemptStatus).toBe("pending"); expect(controller.actionDisabled).toBe(true);
});
it("keeps an uncertain broadcast pending and never automatically resends", async () => {
  await ready(); signNormally();
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => url === "/api/selected-broadcast"
    ? Response.json({ error: "Upstream unavailable" }, { status: 503 }) : handler(url, init));
  await act(async () => controller.primaryAction()); await advance(10000);
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).not.toBeNull();
  expect(controller.attemptStatus).toBe("pending"); expect(controller.actionDisabled).toBe(false);
  expect(controller.walletBlocked).toBe(false); expect(controller.historyWarning).toContain("may add liquidity twice");
});

const oldAttempt = (): SelectedAttempt => ({ version: 2, wallet, selection: { ...selection, positionMint: key() },
  poolId, positionAccount, signature: bs58.encode(new Uint8Array(64).fill(2)), createdAt: Date.now(), requested: "100",
  floorBps: 9900, startingBalances: { input: "1000", a: "0", b: "0" }, startingLiquidity: "1",
  expectedLiquidity: "2", blockhash: wallet, lastValidBlockHeight: 100 });
async function reload() {
  await act(async () => root.unmount()); root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness))); await advance(100); await advance(100);
}
it.each(["pending", "manual-review"])("old %s on another NFT warns but allows a new preview after reload", async status => {
  const prior = oldAttempt(); persistSelectedAttempt(window.localStorage, prior);
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => url === "/api/selected-status"
    ? Response.json({ status, signature: prior.signature, state: null }) : handler(url, init));
  await reload(); await ready();
  expect(controller.attempt?.signature).toBe(prior.signature);
  expect(controller.attemptStatus).toBe(status);
  expect(controller.walletBlocked).toBe(false); expect(controller.historyWarning).toContain("starting again");
  expect(calls("/api/selected-broadcast")).toHaveLength(0); expect(mocks.sign).not.toHaveBeenCalled();
});
it("invalid local records never block fresh input and are retained", async () => {
  const raw = "invalid old record"; window.localStorage.setItem(selectedAttemptKey(wallet), raw);
  await reload(); await ready();
  expect(controller.historyWarning).toBeTruthy();
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(raw);
  expect(mocks.sign).not.toHaveBeenCalled();
});
it("a hanging legacy lookup does not delay preview or require deleting its receipt", async () => {
  const raw = JSON.stringify({ wallet, signature: oldAttempt().signature, lastValidBlockHeight: 100 });
  window.localStorage.setItem(`sofinance:atomic:${wallet}`, raw);
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/transaction-finality" ? new Promise(() => {}) : handler(url, init));
  await reload(); await ready();
  expect(controller.walletBlocked).toBe(false);
  expect(window.localStorage.getItem(`sofinance:atomic:${wallet}`)).toBe(raw);
});
it("old lookup errors cannot overwrite a newer failed preparation", async () => {
  const prior = oldAttempt(); persistSelectedAttempt(window.localStorage, prior);
  let resolve!: (value: Response) => void;
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
    ? new Promise<Response>(done => { resolve = done; }) : handler(url, init));
  await reload(); await ready(); prepareError = true;
  await act(async () => controller.primaryAction());
  await act(async () => resolve(Response.json({ error: "Old lookup failed" }, { status: 503 })));
  expect(controller.error).toBe("Simulation failed");
  expect(controller.verificationError).toBe(""); expect(controller.walletBlocked).toBe(false);
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(JSON.stringify(prior));
});
it("new signed attempts archive the old receipt; no old signature is broadcast", async () => {
  const prior = oldAttempt(); persistSelectedAttempt(window.localStorage, prior);
  await reload(); await ready(); signNormally();
  await act(async () => controller.primaryAction()); await advance(600);
  expect(controller.history.map(item => item.signature)).toContain(prior.signature);
  expect(window.localStorage.getItem(`${selectedAttemptKey(wallet)}:history:${prior.signature}`)).toBe(JSON.stringify(prior));
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
  expect(controller.attempt?.signature).not.toBe(prior.signature);
  expect(controller.actionDisabled).toBe(false);
});

it("an old wallet's late signing failure cannot overwrite the new wallet's error", async () => {
  await ready();
  let reject!: (reason: Error) => void;
  mocks.sign.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => controller.primaryAction());
  mocks.address = key();
  await act(async () => root.render(createElement(Harness))); await advance(50);
  await act(async () => reject(new Error("old wallet failure")));
  expect(controller.error).not.toContain("old wallet failure");
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
});

it("a dropped persistence write prevents broadcast without losing the prior receipt", async () => {
  const prior = oldAttempt(); persistSelectedAttempt(window.localStorage, prior);
  await reload(); await ready(); signNormally();
  const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {});
  await act(async () => controller.primaryAction());
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
  expect(controller.error).toContain("Unable to preserve previous transaction record");
  write.mockRestore();
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(JSON.stringify(prior));
});


// These fixtures preserve the original message and use a nonzero synthetic signature.
// They prove lifecycle/order/bytes ownership, not cryptographic wallet validity.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const syntheticSignature = bs58.encode(new Uint8Array(64).fill(1));
const requestBody = (call: [string, RequestInit?]) => JSON.parse(String(call[1]?.body));
function storageContents() {
  return Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, index) => {
    const key = window.localStorage.key(index)!;
    return [key, window.localStorage.getItem(key)];
  }));
}

it.each(["prepare", "sign"] as const)("lifecycle: unmount during %s stops new wallet/persistence/broadcast work", async stage => {
  const prior = oldAttempt(); persistSelectedAttempt(window.localStorage, prior);
  await reload(); await ready();
  const before = storageContents();
  const writes = vi.spyOn(window.localStorage, "setItem");
  const prepare = deferred<Response>();
  const signing = deferred<VersionedTransaction>();
  let original!: VersionedTransaction;
  let response!: Response;
  const order: string[] = [];
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/selected-prepare") {
      order.push("prepare"); response = await handler(url, init);
      return stage === "prepare" ? prepare.promise : response;
    }
    if (url === "/api/selected-broadcast") order.push("broadcast");
    return handler(url, init);
  });
  mocks.sign.mockImplementation((tx: VersionedTransaction) => {
    order.push("sign"); original = tx;
    if (stage === "sign") return signing.promise;
    tx.signatures[0] = new Uint8Array(64).fill(1); return Promise.resolve(tx);
  });
  await act(async () => controller.primaryAction());
  expect(calls("/api/selected-prepare")).toHaveLength(1);
  expect(requestBody(calls("/api/selected-prepare")[0]!)).toEqual({ wallet, ...selection,
    amount: "0.01", floorBps: 9900, toleranceBps: 100, jupiterRelay: { hints: {}, responses: {} } });
  expect(mocks.sign).toHaveBeenCalledTimes(stage === "sign" ? 1 : 0);
  expect(writes).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  const message = original?.message.serialize();
  await act(async () => {
    if (stage === "prepare") prepare.resolve(response);
    else { original.signatures[0] = new Uint8Array(64).fill(1); signing.resolve(original); }
  });
  if (message) {
    expect(original.message.serialize()).toEqual(message);
    expect(bs58.encode(original.signatures[0]!)).toBe(syntheticSignature);
  }
  expect.soft(order).toEqual(stage === "prepare" ? ["prepare"] : ["prepare", "sign"]);
  expect.soft(mocks.sign).toHaveBeenCalledTimes(stage === "sign" ? 1 : 0);
  expect.soft(writes).not.toHaveBeenCalled();
  expect.soft(calls("/api/selected-broadcast")).toHaveLength(0);
  expect.soft(storageContents()).toEqual(before);
});

it("lifecycle: a captured ready submit callback cannot start after unmount", async () => {
  await ready(); signNormally();
  const submit = controller.primaryAction;
  await act(async () => root.unmount());
  await act(async () => submit());
  expect(calls("/api/selected-prepare")).toHaveLength(0);
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
  expect(storageContents()).toEqual({});
});

it.each([false, true])("lifecycle: mounted submission succeeds once (StrictMode=%s)", async strict => {
  if (strict) {
    await act(async () => root.unmount()); root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness))));
    await advance(100); await advance(100);
  }
  await ready();
  const order: string[] = [];
  let originalMessage!: Uint8Array;
  let signedBytes!: string;
  const write = window.localStorage.setItem.bind(window.localStorage);
  vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => { order.push("persist"); write(key, value); });
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/selected-prepare") order.push("prepare");
    if (url === "/api/selected-broadcast") {
      order.push("broadcast");
      expect(JSON.parse(window.localStorage.getItem(selectedAttemptKey(wallet))!).signature).toBe(syntheticSignature);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ wallet, selection, signedTransaction: signedBytes, permit: "permit",
        requested: "10000000", floorBps: 9900, lastValidBlockHeight: 100,
        startingLiquidity: "1", expectedLiquidity: "100", startingBalances: { input: "1000000000", a: "0", b: "0" } });
    }
    return handler(url, init);
  });
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
    order.push("sign"); originalMessage = tx.message.serialize();
    tx.signatures[0] = new Uint8Array(64).fill(1);
    signedBytes = btoa(String.fromCharCode(...tx.serialize())); return tx;
  });
  await act(async () => { controller.primaryAction(); controller.primaryAction(); });
  expect(order).toEqual(["prepare", "sign", "persist", "broadcast"]);
  expect(calls("/api/selected-prepare")).toHaveLength(1);
  expect(mocks.sign).toHaveBeenCalledOnce();
  const submitted = VersionedTransaction.deserialize(Uint8Array.from(atob(signedBytes), c => c.charCodeAt(0)));
  expect(submitted.message.serialize()).toEqual(originalMessage);
  expect(bs58.encode(submitted.signatures[0]!)).toBe(syntheticSignature);
  expect(controller.busy).toBe(false);
  expect(controller.attempt?.signature).toBe(syntheticSignature);
  expect(calls("/api/selected-status").map(requestBody)).toContainEqual(expect.objectContaining({ signature: syntheticSignature }));
});


it.each(["accepted", "rejected", "lost"] as const)("lifecycle: %s broadcast after unmount retains the original attempt for a new controller", async outcome => {
  await ready(); signNormally();
  const send = deferred<Response>();
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-broadcast" ? send.promise : handler(url, init));
  await act(async () => controller.primaryAction());
  expect(controller.busy).toBe(true);
  const before = storageContents();
  const raw = window.localStorage.getItem(selectedAttemptKey(wallet))!;
  expect(JSON.parse(raw).signature).toBe(syntheticSignature);
  const sent = requestBody(calls("/api/selected-broadcast")[0]!);
  const original = VersionedTransaction.deserialize(Uint8Array.from(atob(sent.signedTransaction), c => c.charCodeAt(0)));
  expect(bs58.encode(original.signatures[0]!)).toBe(syntheticSignature);
  expect(original.message.serialize()).toEqual(mocks.sign.mock.calls[0]![0].message.serialize());
  await reload();
  expect(controller.attempt?.signature).toBe(syntheticSignature);
  expect(calls("/api/selected-status").map(requestBody)).toContainEqual(expect.objectContaining({ signature: syntheticSignature }));
  // Start a valid new controller operation before the old continuation settles.
  await ready();
  const nextSign = deferred<VersionedTransaction>();
  mocks.sign.mockImplementation(() => nextSign.promise);
  await act(async () => controller.primaryAction());
  expect(controller.actionLabel).toBe("Confirming in wallet…");
  const readsBefore = fetchMock.mock.calls.length;
  const writes = vi.spyOn(window.localStorage, "setItem");
  await act(async () => {
    if (outcome === "lost") send.reject(new Error("Response lost after send"));
    else send.resolve(outcome === "accepted" ? Response.json({ signature: syntheticSignature })
      : Response.json({ error: "Rejected response", sent: false }, { status: 503 }));
  });
  expect(fetchMock.mock.calls).toHaveLength(readsBefore);
  expect(writes).not.toHaveBeenCalled();
  expect(storageContents()).toEqual(before);
  expect(controller.busy).toBe(true); expect(controller.error).toBe("");
  await act(async () => nextSign.reject(new Error("New wallet cancellation")));
  expect(controller.busy).toBe(false); expect(controller.error).toBe("New wallet cancellation");
  await advance(10000);
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(raw);
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
  expect(calls("/api/selected-prepare")).toHaveLength(2);
  expect(mocks.sign).toHaveBeenCalledTimes(2); // Explicit new click only; never automatic re-sign.
});

it("lifecycle: a new mount can submit while the old signature is still pending in the wallet", async () => {
  await ready();
  const oldSign = deferred<VersionedTransaction>();
  let original!: VersionedTransaction;
  mocks.sign.mockImplementation((tx: VersionedTransaction) => { original = tx; return oldSign.promise; });
  await act(async () => controller.primaryAction());
  await reload(); await ready(); signNormally();
  await act(async () => controller.primaryAction());
  const before = storageContents();
  await act(async () => { original.signatures[0] = new Uint8Array(64).fill(2); oldSign.resolve(original); });
  expect(storageContents()).toEqual(before);
  expect(controller.attempt?.signature).toBe(syntheticSignature);
  expect(controller.busy).toBe(false);
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
});

it.each(["prepare", "sign"] as const)("lifecycle: effect cleanup/setup cannot revive an old %s continuation", async stage => {
  // Activity disconnects/reconnects effects while retaining the hook's refs and state.
  // Unlike a fresh createRoot, this detects an active boolean resurrecting old work.
  await act(async () => root.unmount()); root = createRoot(document.createElement("div"));
  const render = (mode: "visible" | "hidden") => root.render(
    <StrictMode><Activity mode={mode}><Harness /></Activity></StrictMode>);
  await act(async () => render("visible")); await advance(100); await advance(100); await ready();
  const prepare = deferred<Response>();
  const signing = deferred<VersionedTransaction>();
  let response!: Response;
  let original!: VersionedTransaction;
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/selected-prepare") {
      response = await handler(url, init); return stage === "prepare" ? prepare.promise : response;
    }
    return handler(url, init);
  });
  mocks.sign.mockImplementation((tx: VersionedTransaction) => {
    original = tx;
    if (stage === "sign") return signing.promise;
    tx.signatures[0] = new Uint8Array(64).fill(1); return Promise.resolve(tx);
  });
  await act(async () => controller.primaryAction());
  await act(async () => render("hidden"));
  await act(async () => render("visible"));
  await act(async () => {
    if (stage === "prepare") prepare.resolve(response);
    else { original.signatures[0] = new Uint8Array(64).fill(1); signing.resolve(original); }
  });
  expect(mocks.sign).toHaveBeenCalledTimes(stage === "sign" ? 1 : 0);
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
  expect(storageContents()).toEqual({});
  expect(controller.busy).toBe(false);
  fetchMock.mockImplementation(handler); signNormally();
  await advance(100); await advance(100); await ready();
  await act(async () => controller.primaryAction());
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
  expect(controller.busy).toBe(false);
});

it("lifecycle: expiry during wallet wait still prevents persistence and send", async () => {
  await ready();
  const signing = deferred<VersionedTransaction>();
  let original!: VersionedTransaction;
  mocks.sign.mockImplementation((tx: VersionedTransaction) => { original = tx; return signing.promise; });
  await act(async () => controller.primaryAction()); await advance(75000);
  await act(async () => { original.signatures[0] = new Uint8Array(64).fill(1); signing.resolve(original); });
  expect(controller.error).toContain("changed during signing");
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
  expect(storageContents()).toEqual({});
});


it("lifecycle: late status cannot notify after unmount; a new controller can confirm the same signature", async () => {
  const prior = oldAttempt(); persistSelectedAttempt(window.localStorage, prior);
  const status = deferred<Response>();
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status" ? status.promise.then(response => response.clone()) : handler(url, init));
  await reload();
  expect(calls("/api/selected-status")).toHaveLength(1);
  const retry = controller.retryReconcile;
  await act(async () => root.unmount());
  const before = storageContents();
  await act(async () => {
    status.resolve(Response.json({ status: "success", signature: prior.signature, state: null }));
    retry();
  });
  expect(storageContents()).toEqual(before);
  expect(calls("/api/selected-status")).toHaveLength(1);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness))); await advance(100); await advance(100);
  expect(controller.attemptStatus).toBe("success");
  expect(controller.attempt?.signature).toBe(prior.signature);
  expect(calls("/api/selected-status")).toHaveLength(2);
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(JSON.stringify(prior));
  expect(storageContents()).not.toEqual(before); // The current controller emits the real history marker.
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
  expect(mocks.sign).not.toHaveBeenCalled();
});

async function activityMount() {
  await act(async () => root.unmount());
  root = createRoot(document.createElement("div"));
  const render = (mode: "visible" | "hidden") => root.render(
    <StrictMode><Activity mode={mode}><Harness /></Activity></StrictMode>);
  await act(async () => render("visible"));
  await advance(100); await advance(100); await ready();
  return render;
}

it.each(["prepare-ok", "prepare-error", "sign-ok", "sign-error"])(
  "lifecycle: settlement while hidden must allow a fresh explicit operation (%s)", async phase => {
    const render = await activityMount();
    const prep = deferred<Response>(); const sig = deferred<VersionedTransaction>();
    const handler = fetchMock.getMockImplementation()!;
    let response!: Response; let tx!: VersionedTransaction;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/selected-prepare") {
        response = await handler(url, init); return phase.startsWith("prepare") ? prep.promise : response;
      }
      return handler(url, init);
    });
    mocks.sign.mockImplementation((input: VersionedTransaction) => {
      tx = input;
      if (!phase.startsWith("prepare")) return sig.promise;
      input.signatures[0] = new Uint8Array(64).fill(1);
      return Promise.resolve(input);
    });
    await act(async () => controller.primaryAction());
    expect(controller.busy).toBe(true);
    await act(async () => render("hidden"));
    await act(async () => {
      if (phase === "prepare-ok") prep.resolve(response);
      if (phase === "prepare-error") prep.reject(new Error("Old prepare failure"));
      if (phase === "sign-ok") { tx.signatures[0] = new Uint8Array(64).fill(1); sig.resolve(tx); }
      if (phase === "sign-error") sig.reject(new Error("Old wallet rejection"));
    });
    expect.soft(calls("/api/selected-broadcast")).toHaveLength(0);
    expect.soft(storageContents()).toEqual({});
    fetchMock.mockImplementation(handler); signNormally();
    await act(async () => render("visible")); await advance(100); await advance(100);
    expect.soft(controller.busy).toBe(false);
    expect.soft(controller.error).toBe("");
    await act(async () => controller.changeAmount("0.02")); await advance(500);
    expect.soft(controller.actionDisabled).toBe(false);
    await act(async () => controller.primaryAction());
    expect.soft(calls("/api/selected-prepare")).toHaveLength(2);
    expect.soft(calls("/api/selected-broadcast")).toHaveLength(1);
  });

it.each(["accepted", "rejected", "lost"])("lifecycle: durable %s settlement while hidden must resume status without resend", async result => {
  const render = await activityMount(); const send = deferred<Response>();
  const handler = fetchMock.getMockImplementation()!; signNormally();
  fetchMock.mockImplementation((url,init) => url === "/api/selected-broadcast" ? send.promise : handler(url,init));
  await act(async () => controller.primaryAction());
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
  const before = storageContents(); const raw = window.localStorage.getItem(selectedAttemptKey(wallet));
  await act(async () => render("hidden"));
  await act(async () => {
    if (result === "lost") send.reject(new Error("Synthetic lost reply"));
    else send.resolve(result === "accepted" ? Response.json({signature:syntheticSignature}) : Response.json({error:"synthetic reject", sent:false},{status:503}));
  });
  expect(storageContents()).toEqual(before);
  fetchMock.mockImplementation(handler);
  const statusBefore = calls("/api/selected-status").length;
  await act(async () => render("visible")); await advance(100); await advance(100); await advance(4000);
  expect.soft(controller.busy).toBe(false);
  expect.soft(calls("/api/selected-status").length).toBeGreaterThan(statusBefore);
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(raw);
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
  expect(mocks.sign).toHaveBeenCalledOnce();
  expect(controller.attempt?.signature).toBe(syntheticSignature);
  await act(async () => controller.changeAmount("0.02")); await advance(500);
  expect.soft(controller.actionDisabled).toBe(false);
});

// A Suspense sibling hides the hook's layout effects while retaining passive
// effects; this deliberately differs from the already covered Activity fixture.
async function suspenseMount() {
  await act(async () => root.unmount());
  root = createRoot(document.createElement('div'));
  const wait = deferred<void>();
  const effects = { layout: 0, cleanup: 0, passive: 0, passiveCleanup: 0 };
  function Tracked() {
    useLayoutEffect(() => { effects.layout++; return () => { effects.cleanup++; }; }, []);
    useEffect(() => { effects.passive++; return () => { effects.passiveCleanup++; }; }, []);
    return <Harness />;
  }
  function Suspend({ hide }: { hide: boolean }) { if (hide) throw wait.promise; return null; }
  const render = (hide: boolean) => root.render(<Suspense fallback={<span>loading</span>}><Tracked /><Suspend hide={hide} /></Suspense>);
  await act(async () => render(false)); await advance(100); await advance(100);
  return { render, effects };
}

it("lifecycle: disconnected Suspense reconnect has no attempt to restore", async () => {
  mocks.address = undefined;
  const { render } = await suspenseMount();
  await act(async () => render(true));
  await act(async () => render(false)); await advance(100);
  expect(controller.wallet).toBeUndefined();
  expect(controller.attempt).toBeNull();
  expect(controller.busy).toBe(false);
  expect(calls("/api/selected-status")).toHaveLength(0);
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
  mocks.address = wallet;
  await act(async () => render(false)); await advance(100); await advance(100);
  await ready(); signNormally();
  await act(async () => controller.primaryAction());
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
});

it.each([
  ["prepare", "resolve", "hidden"], ["prepare", "reject", "hidden"],
  ["sign", "resolve", "hidden"], ["sign", "reject", "hidden"],
  ["prepare", "resolve", "visible"], ["prepare", "reject", "visible"],
  ["sign", "resolve", "visible"], ["sign", "reject", "visible"],
] as const)("lifecycle: Suspense %s %s while %s restores prior signature reconciliation", async (phase, outcome, settlement) => {
  const prior = oldAttempt(); persistSelectedAttempt(window.localStorage, prior);
  const { render, effects } = await suspenseMount(); await ready();
  expect(controller.attempt?.signature).toBe(prior.signature);
  const old = deferred<Response>(); const signing = deferred<VersionedTransaction>();
  const handler = fetchMock.getMockImplementation()!;
  let preparedResponse!: Response; let original!: VersionedTransaction;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await handler(url, init);
    if (url !== "/api/selected-prepare") return response;
    preparedResponse = response;
    return phase === "prepare" ? old.promise : response;
  });
  mocks.sign.mockImplementation((tx: VersionedTransaction) => { original = tx; return signing.promise; });
  await act(async () => controller.primaryAction()); expect(controller.busy).toBe(true);
  await act(async () => render(true));
  expect(effects).toEqual({ layout: 1, cleanup: 1, passive: 1, passiveCleanup: 0 });
  const before = storageContents();
  const signCount = mocks.sign.mock.calls.length;
  if (settlement === "visible") {
    await act(async () => render(false));
    await act(async () => controller.primaryAction());
    expect(calls("/api/selected-prepare")).toHaveLength(1);
  }
  await act(async () => {
    if (phase === "prepare") {
      if (outcome === "resolve") old.resolve(preparedResponse);
      else old.reject(new Error("old prepare rejected"));
    } else if (outcome === "resolve") {
      original.signatures[0] = new Uint8Array(64).fill(2); signing.resolve(original);
    } else signing.reject(new Error("old wallet rejected"));
  });
  expect(storageContents()).toEqual(before);
  expect(mocks.sign).toHaveBeenCalledTimes(signCount);
  fetchMock.mockImplementation((url, init) => url === '/api/selected-status'
    ? Promise.resolve(Response.json({status:'success', signature:prior.signature, state:null})) : handler(url, init));
  await act(async () => render(false)); await advance(100); await advance(8000);
  expect(effects).toEqual({ layout: 2, cleanup: 1, passive: 1, passiveCleanup: 0 });
  expect(controller.busy).toBe(false);
  expect(calls('/api/selected-broadcast')).toHaveLength(0);
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(before[selectedAttemptKey(wallet)]);
  expect(controller.attemptStatus).toBe("success");
  const statusCalls = calls("/api/selected-status");
  expect(statusCalls.length).toBeGreaterThan(0);
  expect(statusCalls.map(requestBody)).toEqual(expect.arrayContaining([expect.objectContaining({ signature: prior.signature })]));
  await act(async () => controller.retryReconcile());
  expect(controller.attemptStatus).toBe('success');
  fetchMock.mockImplementation(handler); signNormally();
  await act(async () => controller.changeAmount("0.02")); await advance(500);
  expect(controller.actionDisabled).toBe(false);
  await act(async () => controller.primaryAction());
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
  expect(window.localStorage.getItem(selectedAttemptKey(wallet) + ":history:" + prior.signature)).toBe(before[selectedAttemptKey(wallet)]);
});

it('lifecycle: Suspense durable settlement recovers same signature without resend', async () => {
  const { render, effects } = await suspenseMount(); await ready(); signNormally();
  const send = deferred<Response>(); const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === '/api/selected-broadcast' ? send.promise : handler(url, init));
  await act(async () => controller.primaryAction());
  const raw = window.localStorage.getItem(selectedAttemptKey(wallet));
  await act(async () => render(true));
  await act(async () => send.reject(new Error('lost after send')));
  fetchMock.mockImplementation((url, init) => url === '/api/selected-status'
    ? Promise.resolve(Response.json({status:'success', signature:syntheticSignature, state:null})) : handler(url, init));
  await act(async () => render(false)); await advance(100); await advance(8000);
  expect(effects).toEqual({ layout: 2, cleanup: 1, passive: 1, passiveCleanup: 0 });
  expect(controller.busy).toBe(false); expect(controller.attemptStatus).toBe('success');
  expect(window.localStorage.getItem(selectedAttemptKey(wallet))).toBe(raw);
  expect(calls('/api/selected-broadcast')).toHaveLength(1); expect(mocks.sign).toHaveBeenCalledOnce();
});


it.each(["success", "failed", "expired", "manual-review"])("attempt: terminal %s stops polling; explicit retry keeps original signature", async status => {
  const prior = oldAttempt(); persistSelectedAttempt(localStorage, prior);
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
    ? Promise.resolve(Response.json({ status, signature: prior.signature })) : handler(url, init));
  await reload(); const n = calls("/api/selected-status").length;
  await advance(8000); expect(calls("/api/selected-status")).toHaveLength(n);
  await act(async () => controller.retryReconcile());
  expect(calls("/api/selected-status")).toHaveLength(n + 1);
  expect(controller.attemptStatus).toBe(status);
  expect(localStorage.getItem(selectedAttemptKey(wallet))).toBe(JSON.stringify(prior));
  expect(ledger.filter(e => (e as {kind: string}).kind === "notify")).toHaveLength(status === "success" ? 1 : 0);
  await ready(); expect(controller.walletBlocked).toBe(false);
});

it.each(["signature", "status", "http", "transport"])("attempt: invalid %s preserves record and recovers on explicit retry", async failure => {
  const prior = oldAttempt(); persistSelectedAttempt(localStorage, prior);
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (url !== "/api/selected-status") return handler(url, init);
    if (failure === "transport") throw new Error("status transport");
    return Response.json({ signature: failure === "signature" ? syntheticSignature : prior.signature,
      status: failure === "status" ? "confirmed" : "success", error: "status HTTP" }, {status: failure === "http" ? 503 : 200});
  });
  await reload(); expect(controller.verificationError).toBeTruthy(); expect(controller.attemptStatus).toBe("pending");
  expect(controller.error).toBe(""); expect(localStorage.getItem(selectedAttemptKey(wallet))).toBe(JSON.stringify(prior));
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
    ? Promise.resolve(Response.json({ status: "success", signature: prior.signature })) : handler(url, init));
  await act(async () => controller.retryReconcile());
  expect(controller.verificationError).toBe(""); expect(controller.attemptStatus).toBe("success");
});

it("attempt: last issued request wins without inventing global single flight", async () => {
  const prior = oldAttempt(); persistSelectedAttempt(localStorage, prior);
  const first = deferred<Response>(); const second = deferred<Response>();
  const handler = fetchMock.getMockImplementation()!; let n = 0;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status" ? (++n === 1 ? first.promise : second.promise) : handler(url, init));
  await reload(); await act(async () => controller.retryReconcile()); expect(n).toBe(2);
  await act(async () => second.resolve(Response.json({status:"manual-review",signature:prior.signature})));
  await act(async () => first.resolve(Response.json({status:"success",signature:prior.signature})));
  expect(controller.attemptStatus).toBe("manual-review");
  expect(ledger.filter(e => (e as {kind:string}).kind === "notify")).toHaveLength(0);
});

it.each(["prepare", "sign"])("attempt: %s failure restores old signature and busy suppresses retry/poll", async phase => {
  const prior = oldAttempt(); persistSelectedAttempt(localStorage, prior); await reload(); await ready();
  const pending = deferred<Response>(); const signing = deferred<VersionedTransaction>();
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-prepare" && phase === "prepare" ? pending.promise : handler(url, init));
  mocks.sign.mockImplementation(() => signing.promise);
  await act(async () => controller.primaryAction()); const n = calls("/api/selected-status").length;
  await act(async () => controller.retryReconcile()); await advance(8000);
  expect(calls("/api/selected-status")).toHaveLength(n);
  await act(async () => { if (phase === "prepare") pending.reject(new Error("prepare rejected")); else signing.reject(new Error("sign rejected")); });
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
    ? Promise.resolve(Response.json({status:"success",signature:prior.signature})) : handler(url, init));
  await act(async () => controller.retryReconcile());
  expect(controller.attemptStatus).toBe("success"); expect(controller.error).toBe(phase + " rejected");
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
});

it.each(["pending", "success"])("recovery: history failure publishes durable signature after prior %s without sending", async status => {
  const prior = oldAttempt(); persistSelectedAttempt(localStorage, prior);
  const priorBytes = localStorage.getItem(selectedAttemptKey(wallet));
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
    ? Promise.resolve(Response.json({ status, signature: prior.signature })) : handler(url, init));
  await reload(); await ready(); signNormally();
  fetchMock.mockImplementation(handler);
  const firstStatus = calls("/api/selected-status").length;
  const fault = vi.spyOn(localStorage, "key").mockImplementation(() => { throw new Error("history enumeration failed"); });
  try {
    await act(async () => controller.primaryAction());
    expect(controller.error).toBe("history enumeration failed");
    expect(controller.busy).toBe(false);
    expect(calls("/api/selected-broadcast")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(selectedAttemptKey(wallet))!).signature).toBe(syntheticSignature);
    expect(localStorage.getItem(selectedAttemptKey(wallet) + ":history:" + prior.signature)).toBe(priorBytes);
    expect(controller.attempt?.signature).toBe(syntheticSignature);
    expect(controller.attemptStatus).toBe("pending");
    expect(controller.historyWarning).toContain("may add liquidity twice");
    await act(async () => controller.retryReconcile());
    expect(calls("/api/selected-status").slice(firstStatus).map(requestBody))
      .toEqual([expect.objectContaining({ signature: syntheticSignature })]);
    expect(controller.error).toBe("history enumeration failed");
    expect(controller.attemptStatus).toBe("pending");
  } finally { fault.mockRestore(); }
  const durable = localStorage.getItem(selectedAttemptKey(wallet));
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
    ? Promise.resolve(Response.json({ status: "expired", signature: syntheticSignature })) : handler(url, init));
  await reload(); await ready();
  expect(controller.attempt?.signature).toBe(syntheticSignature);
  expect(controller.attemptStatus).toBe("expired");
  expect(controller.history.map(item => item.signature)).toContain(prior.signature);
  expect(controller.actionDisabled).toBe(false);
  const count = calls("/api/selected-status").length;
  await advance(8000); expect(calls("/api/selected-status")).toHaveLength(count);
  expect(localStorage.getItem(selectedAttemptKey(wallet))).toBe(durable);
  expect(localStorage.getItem(selectedAttemptKey(wallet) + ":history:" + prior.signature)).toBe(priorBytes);
  expect(mocks.sign).toHaveBeenCalledOnce();
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
});

it.each(["resolve", "reject"] as const)("recovery: legacy retry %s only changes the initiating wallet warning", async outcome => {
  const prior = oldAttempt(); const legacyKey = `sofinance:atomic:${wallet}`;
  const raw = JSON.stringify({ wallet, signature: prior.signature, lastValidBlockHeight: 100 });
  localStorage.setItem(legacyKey, raw);
  const handler = fetchMock.getMockImplementation()!; const late = deferred<Response>(); let n = 0;
  fetchMock.mockImplementation((url, init) => url === "/api/transaction-finality"
    ? (++n === 1 ? Promise.resolve(Response.json({status:"finalized"})) : late.promise) : handler(url, init));
  await reload(); expect(controller.obsoletePending).toBe(false);
  await act(async () => controller.retryObsoleteReconcile()); expect(n).toBe(2);
  const other = key(); mocks.address = other;
  await act(async () => root.render(createElement(Harness))); await advance(30); await advance(30);
  expect(controller.wallet).toBe(other); expect(controller.historyWarning).toBe("");
  await act(async () => {
    if (outcome === "resolve") late.resolve(Response.json({status:"pending"}));
    else late.reject(new Error("old wallet unavailable"));
  });
  expect(controller.obsoletePending).toBe(false); expect(controller.historyWarning).toBe("");
  expect(controller.walletBlocked).toBe(false); expect(controller.verificationError).toBe("");
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/selected-broadcast")).toHaveLength(0);
});

it("recovery: current wallet legacy retry rejection still warns and can recover", async () => {
  const prior = oldAttempt(); const legacyKey = `sofinance:atomic:${wallet}`;
  const raw = JSON.stringify({ wallet, signature: prior.signature, lastValidBlockHeight: 100 });
  localStorage.setItem(legacyKey, raw);
  const handler = fetchMock.getMockImplementation()!; let fail = false;
  fetchMock.mockImplementation((url, init) => url === "/api/transaction-finality"
    ? (fail ? Promise.reject(new Error("current wallet unavailable")) : Promise.resolve(Response.json({status:"finalized"}))) : handler(url, init));
  await reload(); expect(controller.obsoletePending).toBe(false);
  fail = true; await act(async () => controller.retryObsoleteReconcile());
  expect(controller.obsoletePending).toBe(true); expect(controller.historyWarning).toContain("may add liquidity twice");
  await ready(); expect(controller.actionDisabled).toBe(false);
  fail = false; await act(async () => controller.retryObsoleteReconcile());
  expect(controller.obsoletePending).toBe(false); expect(controller.historyWarning).toBe("");
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/selected-broadcast")).toHaveLength(0);
});

it("attempt: legacy records are queried sequentially with exact body and eight second timeout", async () => {
  const prior = oldAttempt(); const first = deferred<Response>();
  const keys = [`sofinance:atomic:${wallet}`, `usdc-position-zap:atomic:${wallet}`];
  keys.forEach((k, i) => localStorage.setItem(k, JSON.stringify({wallet,signature:prior.signature,lastValidBlockHeight:100+i})));
  const timeout = vi.spyOn(AbortSignal, "timeout"); const handler = fetchMock.getMockImplementation()!; let n = 0;
  fetchMock.mockImplementation((url, init) => url === "/api/transaction-finality"
    ? (++n === 1 ? first.promise : Promise.resolve(Response.json({status:"expired"}))) : handler(url, init));
  await reload(); await ready(); expect(n).toBe(1); expect(controller.obsoletePending).toBe(true);
  expect(requestBody(calls("/api/transaction-finality")[0]!)).toEqual({signature:prior.signature,lastValidBlockHeight:100});
  await act(async () => first.resolve(Response.json({status:"finalized"})));
  expect(n).toBe(2); expect(controller.obsoletePending).toBe(false);
  expect(requestBody(calls("/api/transaction-finality")[1]!)).toEqual({signature:prior.signature,lastValidBlockHeight:101});
  expect(timeout.mock.calls).toEqual([[8000],[8000]]); keys.forEach(k => expect(localStorage.getItem(k)).not.toBeNull());
});

it("attempt: poll starts at zero, repeats at four seconds, and suppresses only its own in-flight request", async () => {
  const prior = oldAttempt(); persistSelectedAttempt(localStorage, prior);
  await act(async () => root.unmount()); root = createRoot(document.createElement("div"));
  const old = deferred<Response>(); const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status" ? old.promise : handler(url, init));
  await act(async () => root.render(createElement(Harness)));
  expect(calls("/api/selected-status")).toHaveLength(0);
  await advance(0); await advance(0); expect(calls("/api/selected-status")).toHaveLength(1);
  await advance(8000); expect(calls("/api/selected-status")).toHaveLength(1);
  await act(async () => old.resolve(Response.json({status:"pending",signature:prior.signature})));
  fetchMock.mockImplementation(handler);
  await advance(3999); expect(calls("/api/selected-status")).toHaveLength(1);
  await advance(1); expect(calls("/api/selected-status")).toHaveLength(2);
});

it("attempt: wallet display fencing hides old warning before zero-delay load; stale success cannot notify", async () => {
  const prior = oldAttempt(); persistSelectedAttempt(localStorage, prior);
  const old = deferred<Response>(); const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status" ? old.promise : handler(url, init));
  await reload(); expect(controller.historyWarning).toBeTruthy();
  mocks.address = key(); await act(async () => root.render(createElement(Harness)));
  expect(controller.historyWarning).toBe(""); expect(controller.history).toEqual([]);
  await advance(30); await act(async () => old.resolve(Response.json({status:"success",signature:prior.signature})));
  expect(controller.attempt).toBeNull(); expect(controller.verificationError).toBe("");
  expect(ledger.filter(e => (e as {kind:string}).kind === "notify")).toHaveLength(0);
  expect(localStorage.getItem(selectedAttemptKey(wallet))).toBe(JSON.stringify(prior));
});

it.each(["balances", "wallet", "selection", "floor", "tolerance", "payer", "blockhash"])(
  "submission: rejects prepared %s mismatch before wallet and permits a healthy fresh operation", async field => {
    await ready(); signNormally();
    tweakPrepared = value => {
      if (field === "balances") Object.assign(value, { startingBalances: null });
      if (field === "wallet") value.quote.wallet = key();
      if (field === "selection") value.quote.positionMint = key();
      if (field === "floor") value.quote.floorBps = 9500;
      if (field === "tolerance") value.quote.toleranceBps = 0;
      if (field === "blockhash") value.blockhash = key();
      if (field === "payer") {
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(key()), recentBlockhash: wallet, instructions: [] }).compileToV0Message());
        value.unsignedTransaction = btoa(String.fromCharCode(...tx.serialize()));
      }
    };
    await act(async () => controller.primaryAction());
    expect(controller.error).toBe(field === "payer" || field === "blockhash" ? "Transaction payer or blockhash mismatch" : "Requote or transaction authorization and current selection mismatch");
    expect(mocks.sign).not.toHaveBeenCalled(); expect(localStorage.getItem(selectedAttemptKey(wallet))).toBeNull();
    expect(calls("/api/selected-broadcast")).toHaveLength(0);
    tweakPrepared = () => {}; await ready(); await act(async () => controller.primaryAction());
    expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("/api/selected-broadcast")).toHaveLength(1);
  });

it.each(["archive-throw", "archive-drop", "archive-readback", "current-throw", "current-drop", "current-readback", "current-readback-throw", "history-key", "history-length"])(
  "submission: durable boundary %s retains exact bytes and restores an adopted query owner", async fault => {
    const prior = oldAttempt(); const currentKey = selectedAttemptKey(wallet);
    const priorRaw = JSON.stringify({ ...prior, retainedExtra: true }, null, 2);
    localStorage.setItem(currentKey, priorRaw); await reload(); await ready(); signNormally();
    const storage = window.localStorage;
    let written = false, archived = false, faults = 0;
    const proxy = new Proxy(storage, { get(target, property) {
      if (property === "length" && fault === "history-length" && written) { faults++; throw new Error(fault); }
      if (property === "setItem") return (k: string, v: string) => {
        const mode = k.includes(":history:") ? "archive" : "current";
        if (fault === mode + "-throw") { faults++; throw new Error(fault); }
        if (fault === mode + "-drop") { faults++; return; }
        target.setItem(k, v);
        if (mode === "archive") archived = true; else written = true;
      };
      if (property === "getItem") return (k: string) => {
        if (fault === "archive-readback" && archived && k.includes(":history:")) { faults++; return null; }
        if (written && k === currentKey) {
          if (fault === "current-readback") { faults++; return priorRaw; }
          if (fault === "current-readback-throw") { faults++; throw new Error(fault); }
        }
        return target.getItem(k);
      };
      if (property === "key" && fault === "history-key" && written) return () => { faults++; throw new Error(fault); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const getter = vi.spyOn(window, "localStorage", "get").mockReturnValue(proxy);
    try { await act(async () => controller.primaryAction()); }
    finally { getter.mockRestore(); }
    expect(faults).toBeGreaterThan(0); expect(controller.error).not.toBe("");
    expect(controller.busy).toBe(false); expect(calls("/api/selected-broadcast")).toHaveLength(0);
    const published = fault.startsWith("history-");
    expect(controller.attempt?.signature).toBe(published ? syntheticSignature : prior.signature);
    if (archived) expect(storage.getItem(`${currentKey}:history:${prior.signature}`)).toBe(priorRaw);
    const durable = JSON.parse(storage.getItem(currentKey)!) as SelectedAttempt;
    expect(durable.signature).toBe(written ? syntheticSignature : prior.signature);
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
      ? Promise.resolve(Response.json({ signature: requestBody([url, init]).signature, status: "expired" })) : handler(url, init));
    await act(async () => controller.retryReconcile());
    expect(requestBody(calls("/api/selected-status").at(-1)!).signature).toBe(published ? syntheticSignature : prior.signature);
    expect(controller.attemptStatus).toBe("expired");
    await reload(); expect(controller.attempt?.signature).toBe(durable.signature); expect(controller.attemptStatus).toBe("expired");
    await ready(); await act(async () => controller.primaryAction());
    expect(calls("/api/selected-broadcast")).toHaveLength(1); expect(mocks.sign).toHaveBeenCalledTimes(2);
  });

it.each(["mismatched", "sent-false", "lost"])("submission: %s broadcast retains original serialized bytes and reload queries without resend", async outcome => {
  const prior = oldAttempt(); const priorRaw = JSON.stringify(prior, null, 2);
  localStorage.setItem(selectedAttemptKey(wallet), priorRaw); await reload(); await ready();
  let signedBytes = "", messageBytes = "";
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
    messageBytes = btoa(String.fromCharCode(...tx.message.serialize()));
    tx.signatures[0] = new Uint8Array(64).fill(1); signedBytes = btoa(String.fromCharCode(...tx.serialize())); return tx;
  });
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => {
    if (url === "/api/selected-broadcast") {
      expect(requestBody([url, init]).signedTransaction).toBe(signedBytes);
      expect(JSON.parse(localStorage.getItem(selectedAttemptKey(wallet))!).signature).toBe(syntheticSignature);
      if (outcome === "lost") return Promise.reject(new Error("lost response"));
      return Promise.resolve(outcome === "mismatched" ? Response.json({signature: prior.signature}) : Response.json({error:"uncertain rejection",sent:false},{status:503}));
    }
    return handler(url, init);
  });
  await act(async () => controller.primaryAction());
  expect(controller.error).toBe(outcome === "lost" ? "lost response" : outcome === "sent-false" ? "uncertain rejection" : "Dedicated RPC returned inconsistent transaction signature, check on-chain status");
  const sent = VersionedTransaction.deserialize(Uint8Array.from(atob(signedBytes), c => c.charCodeAt(0)));
  expect(btoa(String.fromCharCode(...sent.message.serialize()))).toBe(messageBytes);
  expect(bs58.encode(sent.signatures[0]!)).toBe(syntheticSignature);
  expect(controller.attempt?.signature).toBe(syntheticSignature); expect(controller.attemptStatus).toBe("pending");
  expect(localStorage.getItem(`${selectedAttemptKey(wallet)}:history:${prior.signature}`)).toBe(priorRaw);
  fetchMock.mockImplementation((url, init) => url === "/api/selected-status"
    ? Promise.resolve(Response.json({signature: requestBody([url, init]).signature,status:"manual-review"})) : handler(url, init));
  await act(async () => controller.retryReconcile()); expect(controller.attemptStatus).toBe("manual-review");
  await advance(8000); await reload(); expect(controller.attemptStatus).toBe("manual-review");
  expect(requestBody(calls("/api/selected-status").at(-1)!).signature).toBe(syntheticSignature);
  expect(mocks.sign).toHaveBeenCalledOnce(); expect(calls("/api/selected-broadcast")).toHaveLength(1);
});

it("submission: captured ready callback keeps its input snapshot after a later render", async () => {
  await ready(); const captured = controller.primaryAction;
  await act(async () => controller.changeAmount("0.02")); await advance(500); signNormally();
  await act(async () => captured());
  expect(requestBody(calls("/api/selected-prepare")[0]!).amount).toBe("0.01");
  expect(requestBody(calls("/api/selected-broadcast")[0]!).requested).toBe("10000000");
  expect(controller.amount).toBe("0.02"); expect(controller.attempt?.requested).toBe("10000000");
});

it.each(["timeout", "json-error", "http-error"])("submission: deferred prepare JSON preserves %s precedence and stage timing", async outcome => {
  await ready(); const json = deferred<unknown>(); let signal!: AbortSignal;
  fetchMock.mockImplementationOnce(async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return { ok: false, json: () => json.promise } as Response;
  });
  await act(async () => controller.primaryAction());
  expect(controller.actionLabel).toBe("Preparing latest transaction…"); expect(controller.walletBlocked).toBe(true);
  await advance(RELAY_DEADLINE_MS - 1); expect(signal.aborted).toBe(false);
  if (outcome !== "http-error") { await advance(1); expect(signal.aborted).toBe(true); }
  await act(async () => {
    if (outcome === "json-error") json.reject(new Error("JSON parse failed"));
    else json.resolve({error:"HTTP rejected"});
  });
  expect(controller.error).toBe(outcome === "timeout" ? "Preparation took too long. Please retry." : outcome === "json-error" ? "JSON parse failed" : "HTTP rejected");
  expect(controller.busy).toBe(false); expect(mocks.sign).not.toHaveBeenCalled();
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
  await ready(); signNormally(); await act(async () => controller.primaryAction());
  expect(calls("/api/selected-broadcast")).toHaveLength(1);
});

it.each(["prepare", "sign"] as const)("submission: selection change during %s prevents persistence and send", async phase => {
  await ready(); const preparation = deferred<Response>(), signing = deferred<VersionedTransaction>();
  let original!: VersionedTransaction;
  const handler = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => url === "/api/selected-prepare" ? preparation.promise : handler(url, init));
  mocks.sign.mockImplementation((tx: VersionedTransaction) => { original = tx; return signing.promise; });
  await act(async () => controller.primaryAction());
  const response = await handler(...calls("/api/selected-prepare")[0]!);
  if (phase === "sign") await act(async () => preparation.resolve(response));
  await act(async () => controller.choosePosition(key()));
  await act(async () => {
    if (phase === "prepare") preparation.resolve(response);
    else { original.signatures[0] = new Uint8Array(64).fill(1); signing.resolve(original); }
  });
  expect(mocks.sign).toHaveBeenCalledTimes(phase === "prepare" ? 0 : 1);
  expect(localStorage.getItem(selectedAttemptKey(wallet))).toBeNull();
  expect(calls("/api/selected-broadcast")).toHaveLength(0); expect(controller.busy).toBe(false);
});
