// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
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
import { openAttemptKey, persistOpenAttempt } from "@/lib/open-attempt";
import { appendWalletExtraInstruction, buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
const mocks = vi.hoisted(() => ({ address: "", sign: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.address, connected: true, signTransaction: mocks.sign }) }));
const payer = testKeypair(1), nft = testKeypair(2);
const wallet = payer.publicKey.toBase58();
const poolId = testKeypair(42).publicKey.toBase58();
const pair: OpenPositionPair = { poolAddress: poolId, mintA: testKeypair(8).publicKey.toBase58(), mintB: testKeypair(9).publicKey.toBase58(),
  symbolA: "AAA", symbolB: "BBB", wrappedSymbol: "AAAx", plainSymbol: "AAA", feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false };
let currentPair: OpenPositionPair;
let ledger: unknown[];
let controller: ReturnType<typeof useOpenPositionController>;
let root: Root, container: HTMLDivElement;
let chainStatus: string, sendMode: "ok" | "lost" | "unsent" | "mismatch";
let verificationError: boolean;
let preparedOverride: ((value: ReturnType<typeof prepared>) => void) | null;
let prepareWait: Promise<Response> | null;
let fetchMock: ReturnType<typeof vi.fn>;
function prepared(nftMint = nft.publicKey) {
  const tx = buildTransaction({
    payer,
    extraSigners: [{ publicKey: nftMint, secretKey: new Uint8Array(64) } as typeof nft],
    signWith: [],
  });
  const summary = openSummaryFixture({ wallet, nftMint: nftMint.toBase58(), blockhash: tx.message.recentBlockhash });
  const quote = { ...summary.quote, poolId, inputMint: NATIVE_SOL_MINT, inputKind: "token", inputDecimals: 9 };
  return { unsignedTransaction: toBase64(tx), permit: "test-permit", summary: { ...summary, quote } };
}
function Harness() {
  const value = useOpenPositionController(currentPair);
  useEffect(() => { controller = value; const { submitStage, signature, positionMint, error, actionDisabled, beamStatus, quote, quoteError, quoteLoading } = value;
    ledger.push([Date.now(), "commit", { submitStage, signature, positionMint, error, actionDisabled, beamStatus, quote, quoteError, quoteLoading }]); });
  return null;
}
const calls = (url: string) => fetchMock.mock.calls.filter(([path]) => path === url);
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() {
  await act(async () => root.render(createElement(Harness)));
  await advance(1);
  await act(async () => controller.changeAmount("0.002"));
  await advance(450);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000); ledger = []; currentPair = pair; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  window.localStorage.clear(); mocks.address = wallet;
  const storage = window.localStorage;
  const wrappedStorage = {
    getItem: (key: string) => { ledger.push([Date.now(), "get", key]); return storage.getItem(key); },
    setItem: (key: string, value: string) => { ledger.push([Date.now(), "set", key, value]); storage.setItem(key, value); },
    removeItem: (key: string) => { ledger.push([Date.now(), "remove", key]); storage.removeItem(key); },
    get length() { return storage.length; }, key: storage.key.bind(storage),
  };
  vi.spyOn(window, "localStorage", "get").mockReturnValue(new Proxy(storage, { get: (target, key) => key in wrappedStorage ? wrappedStorage[key as keyof typeof wrappedStorage] : Reflect.get(target, key) }));
  chainStatus = "pending"; sendMode = "ok"; verificationError = false; preparedOverride = null; prepareWait = null;
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { ledger.push([Date.now(), "sign", toBase64(tx)]); tx.sign([payer]); ledger.push([Date.now(), "signed", toBase64(tx)]); return tx; });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    ledger.push([Date.now(), "fetch", url, init?.body ?? null]);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.startsWith("/api/wallet")) return Response.json({ assets: [{ kind: "token", mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true }] });
    if (url === "/api/open-quote") return Response.json(prepared().summary.quote);
    if (url === "/api/open-prepare") {
      if (prepareWait) {
        const signal = init?.signal;
        if (!signal) return prepareWait;
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
          void prepareWait!.then(resolve, reject);
        });
      }
      expect(typeof body.nftMint).toBe("string");
      const value = prepared(new PublicKey(body.nftMint));
      preparedOverride?.(value); return Response.json(value);
    }
    if (url === "/api/open-broadcast") {
      expect(window.localStorage.getItem(openAttemptKey(wallet))).toContain('"signature"');
      if (sendMode === "lost") throw new Error("socket hang up");
      if (sendMode === "unsent") return Response.json({ error: "preflight rejected", sent: false }, { status: 400 });
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      expect(tx.signatures[0]?.some((byte: number) => byte !== 0)).toBe(true);
      expect(tx.signatures[1]?.some((byte: number) => byte !== 0)).toBe(true);
      return Response.json({ signature: sendMode === "mismatch" ? "wrong" : bs58.encode(tx.signatures[0]!), beamLabel: "Beam landed", positionMint: tx.message.staticAccountKeys[1]!.toBase58() });
    }
    if (url === "/api/open-status") {
      if (verificationError) throw new Error("RPC unavailable");
      return Response.json({ signature: body.attempt.signature, status: chainStatus });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async context => { await act(async () => root.unmount()); container.remove();
  ledger.push([Date.now(), "sign-count", mocks.sign.mock.calls.length]);
  // eslint-disable-next-line no-console -- Raw before/after characterization evidence.
  console.log("OPEN_CONSUMER_LEDGER " + JSON.stringify({ name: context.task.name, ledger }));
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("open-position transaction lifecycle", () => {
  it("persists before send and stays pending until finalized position verification", async () => {
    await mount(); expect(controller.actionDisabled).toBe(false);
    await act(async () => controller.signAndSend()); await advance(1);
    expect(controller.submitStage).toBe("pending"); expect(controller.signature).not.toBe("");
    expect(controller.actionDisabled).toBe(true);
    chainStatus = "confirmed"; await advance(3000);
    expect(controller.submitStage).toBe("confirmed"); expect(controller.error).toBe("");
    await act(async () => controller.createAnother()); await advance(450);
    expect(controller.actionDisabled).toBe(false);
  });
  it("keeps wallet-level lock across pools and same-pool position projection", async () => {
    await mount(); await act(async () => controller.signAndSend()); await advance(1);
    const original = controller.signature; currentPair = { ...pair, poolAddress: pair.mintA };
    await act(async () => root.render(createElement(Harness)));
    expect(controller.actionDisabled).toBe(true); expect(controller.submitStage).toBe("pending");
    expect(controller.signature).toBe(original); expect(controller.positionMint).toBe("");
    chainStatus = "confirmed"; await advance(3000); expect(controller.submitStage).toBeNull();
    currentPair = pair; await act(async () => root.render(createElement(Harness)));
    expect(controller.submitStage).toBe("confirmed"); expect(controller.positionMint).toBe(JSON.parse(window.localStorage.getItem(openAttemptKey(wallet))!).nftMint);
  });
  it("shows Beam only after confirmed and createAnother retains receipt while preparing a new quote", async () => {
    await mount(); await act(async () => controller.signAndSend()); await advance(1);
    expect(controller.beamStatus.landedLabel).toBeNull(); chainStatus = "confirmed"; await advance(3000);
    expect(controller.beamStatus.landedLabel).toBe("Beam landed"); const raw = window.localStorage.getItem(openAttemptKey(wallet));
    await act(async () => controller.createAnother()); expect(controller.signature).toBe("");
    expect(controller.positionMint).toBe(JSON.parse(raw!).nftMint); expect(controller.beamStatus.landedLabel).toBeNull();
    expect(window.localStorage.getItem(openAttemptKey(wallet))).toBe(raw); await advance(450); expect(controller.actionDisabled).toBe(false);
    chainStatus = "pending"; await act(async () => controller.signAndSend()); expect(mocks.sign).toHaveBeenCalledTimes(2);
  });
  it("keeps mismatched broadcast and manual-review locked without re-signing", async () => {
    await mount(); sendMode = "mismatch"; await act(async () => controller.signAndSend()); await advance(1);
    expect(controller.error).toContain("unconfirmed"); const signature = controller.signature;
    chainStatus = "manual-review"; await advance(3000); expect(controller.error).toContain("manual verification");
    await act(async () => { controller.createAnother(); void controller.signAndSend(); });
    expect(controller.signature).toBe(signature); expect(controller.actionDisabled).toBe(true); expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it("retains a lost submission response and recovers it after remount without re-signing", async () => {
    await mount(); sendMode = "lost";
    await act(async () => controller.signAndSend()); await advance(1);
    const signature = controller.signature;
    expect(controller.submitStage).toBe("pending"); expect(controller.actionDisabled).toBe(true);
    await act(async () => root.unmount()); root = createRoot(container);
    await mount();
    expect(controller.signature).toBe(signature); expect(controller.submitStage).toBe("pending");
    expect(calls("/api/open-prepare")).toHaveLength(1); expect(mocks.sign).toHaveBeenCalledOnce();
    chainStatus = "confirmed"; await advance(3000); expect(controller.submitStage).toBe("confirmed");
  });
  it.each(["failed", "expired"])("reports %s and allows retry while retaining the signature", async status => {
    await mount(); await act(async () => controller.signAndSend());
    chainStatus = status; await advance(1); await advance(450);
    expect(controller.submitStage).toBe(status); expect(controller.error).toContain(status);
    expect(controller.actionDisabled).toBe(false); expect(controller.signature).not.toBe("");
  });
  it("releases only a definite unsent rejection, preserving its archive", async () => {
    await mount(); sendMode = "unsent";
    await act(async () => controller.signAndSend()); await advance(450);
    expect(controller.error).toContain("safe to retry"); expect(controller.actionDisabled).toBe(false);
    expect(window.localStorage.getItem(openAttemptKey(wallet))).toBeNull();
    expect(Object.keys(window.localStorage).some(key => key.includes(":unsent:"))).toBe(true);
  });
  it("keeps unknown confirmation errors locked and the original record intact", async () => {
    await mount(); await act(async () => controller.signAndSend()); verificationError = true; await advance(1);
    expect(controller.actionDisabled).toBe(true); expect(controller.error).toContain("RPC unavailable");
    expect(window.localStorage.getItem(openAttemptKey(wallet))).toContain(controller.signature);
  });
  it("blocks corrupted history instead of deleting it", async () => {
    window.localStorage.setItem(openAttemptKey(wallet), "broken"); await mount();
    expect(controller.actionDisabled).toBe(true); expect(controller.error).toContain("cannot be verified");
    expect(window.localStorage.getItem(openAttemptKey(wallet))).toBe("broken");
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("never broadcasts when storage silently drops the signed record", async () => {
    await mount(); const actual = window.localStorage;
    const spy = vi.spyOn(window, "localStorage", "get").mockReturnValue({
      getItem: actual.getItem.bind(actual), setItem: vi.fn(), removeItem: actual.removeItem.bind(actual),
    } as unknown as Storage);
    try {
      await act(async () => controller.signAndSend());
      expect(calls("/api/open-broadcast")).toHaveLength(0); expect(controller.error).toContain("Unable to save");
    } finally { spy.mockRestore(); }
  });
  it("rejects a mismatched prepared selection before wallet signing", async () => {
    await mount(); preparedOverride = value => { value.summary.poolId = pair.mintA; };
    await act(async () => controller.signAndSend());
    expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/open-broadcast")).toHaveLength(0);
  });
  it("surfaces a prepare timeout instead of spinning forever", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const extra = new AbortController();
      window.setTimeout(() => extra.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
      return extra.signal;
    });
    await mount();
    prepareWait = new Promise(() => {});
    await act(async () => { void controller.signAndSend(); });
    expect(controller.submitStage).toBe("preparing");
    await advance(OPEN_PREPARE_TIMEOUT_MS);
    expect(controller.submitStage).toBe(null);
    expect(controller.error).toMatch(/timed out|retry/i);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("ignores a late prepare response after the wallet switches", async () => {
    await mount(); let release!: (value: Response) => void;
    prepareWait = new Promise(resolve => { release = resolve; });
    let signing!: Promise<void>;
    await act(async () => { signing = controller.signAndSend(); });
    mocks.address = testKeypair(3).publicKey.toBase58();
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { release(Response.json(prepared())); await signing; });
    expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/open-broadcast")).toHaveLength(0);
  });
  it("preserves an unresolved record belonging to another tab", async () => {
    await mount();
    persistOpenAttempt(window.localStorage, { version: 1, wallet, signature: bs58.encode(new Uint8Array(64).fill(3)),
      nftMint: nft.publicKey.toBase58(), positionAccount: pair.mintA, poolId, tickLower: -60, tickUpper: 60,
      liquidity: "777", blockhash: prepared().summary.blockhash, lastValidBlockHeight: 150, createdAt: Date.now() });
    await act(async () => controller.signAndSend());
    expect(calls("/api/open-broadcast")).toHaveLength(0); expect(controller.error).toContain("history changed");
  });
  it("does not broadcast a signing result after the modal unmounts", async () => {
    await mount(); let release!: (tx: VersionedTransaction) => void;
    let signed!: VersionedTransaction;
    mocks.sign.mockImplementation((tx: VersionedTransaction) => { tx.sign([payer]); signed = tx; return new Promise(resolve => { release = resolve; }); });
    let sending!: Promise<void>;
    await act(async () => { sending = controller.signAndSend(); });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => { release(signed); await sending; });
    expect(calls("/api/open-broadcast")).toHaveLength(0);
    expect(window.localStorage.getItem(openAttemptKey(wallet))).toBeNull();
  });
  it("aborts when the wallet modifies the message and never mint-signs or broadcasts", async () => {
    await mount();
    mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
      tx.message.recentBlockhash = "11111111111111111111111111111111";
      tx.sign([payer]);
      return tx;
    });
    await act(async () => controller.signAndSend());
    expect(calls("/api/open-broadcast")).toHaveLength(0);
    expect(controller.error).toContain("Wallet changed the transaction blockhash");
  });
  it("broadcasts after the wallet appends a Lighthouse instruction", async () => {
    await mount();
    mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
      const extra = appendWalletExtraInstruction(tx);
      extra.sign([payer]);
      return extra;
    });
    await act(async () => controller.signAndSend());
    expect(calls("/api/open-broadcast")).toHaveLength(1);
    expect(controller.error).toBe("");
  });
});


it.each([false, true])("late unsent keeps newer receipt locked before another sign (storage event: %s)", async event => {
  await mount(); const originalFetch = fetchMock.getMockImplementation()! as (url: string, init?: RequestInit) => Promise<Response>;
  let release!: (value: Response) => void;
  const waiting = new Promise<Response>(resolve => { release = resolve; });
  fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/open-broadcast" ? waiting : originalFetch(url, init));
  let sending!: Promise<void>; await act(async () => { sending = controller.signAndSend(); });
  const key = openAttemptKey(wallet), raw = window.localStorage.getItem(key)!;
  const original = JSON.parse(raw), newer = { ...original, signature: bs58.encode(new Uint8Array(64).fill(44)) };
  persistOpenAttempt(window.localStorage, newer);
  if (event) window.dispatchEvent(new StorageEvent("storage", { key, oldValue: raw, newValue: JSON.stringify(newer) }));
  await act(async () => { release(Response.json({ error: "preflight", sent: false }, { status: 400 })); await sending; });
  await advance(450);
  expect(controller.actionDisabled).toBe(true); expect(controller.signature).toBe(newer.signature);
  expect(controller.error).not.toContain("safe to retry");
  expect(window.localStorage.getItem(key)).toBe(JSON.stringify(newer));
  expect(window.localStorage.getItem(key + ":history:" + original.signature)).toBe(raw);
  await act(async () => controller.signAndSend());
  expect(mocks.sign).toHaveBeenCalledTimes(1); expect(calls("/api/open-prepare")).toHaveLength(1);
  expect(calls("/api/open-broadcast")).toHaveLength(1);
  fetchMock.mockImplementation(originalFetch); chainStatus = "expired";
  await act(async () => controller.retryConfirmation()); await advance(450);
  expect(controller.actionDisabled).toBe(false);
  chainStatus = "pending"; await act(async () => controller.signAndSend());
  expect(mocks.sign).toHaveBeenCalledTimes(2); expect(calls("/api/open-broadcast")).toHaveLength(2);
});
