// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { RELAY_DEADLINE_MS, useSelectedController } from "./use-selected-controller";
import { persistSelectedAttempt, selectedAttemptKey, type SelectedAttempt } from "@/lib/selected-attempt";

const mocks = vi.hoisted(() => ({ sign: vi.fn(), address: "11111111111111111111111111111111" }));
const wallet = "11111111111111111111111111111111";
const key = () => Keypair.generate().publicKey.toBase58();
const selection = { positionMint: key(), inputMint: key(), inputKind: "token" as const };
const poolId = key();
const positionAccount = key();
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({
  address: mocks.address, connected: true, signTransaction: mocks.sign,
}) }));
let controller: ReturnType<typeof useSelectedController>;
let root: Root;
let prepareError: boolean;
let tweakPrepared: (value: ReturnType<typeof prepared>) => void;
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
function Harness() {
  const current = useSelectedController();
  useEffect(() => { controller = current; });
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
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness))); await advance(30); await advance(30); await advance(30);
});
afterEach(async () => {
  await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals();
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
  expect(controller.error).toContain("Wallet modified transaction content");
  expect(calls("/api/selected-broadcast")).toHaveLength(0);
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
  await act(async () => controller.primaryAction()); await advance(10000);
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
