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
import { HSOL_MINT, SOL_HSOL_CLMM_POOL_ID } from "@/lib/rwa-allowlist";
import { SOL_POOL_NATIVE_INPUT_MESSAGE } from "@/lib/sol-pool-native-input";
import { noticeIdFor, resetTxNotices, settleTxNotice } from "@/lib/tx-pipeline";
import { appendWalletExtraInstruction, buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
const mocks = vi.hoisted(() => ({ address: "", sign: vi.fn(), signAndSend: undefined as undefined | ReturnType<typeof vi.fn> }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.address, connected: true, signTransaction: mocks.sign, signAndSendTransaction: mocks.signAndSend }) }));
const payer = testKeypair(1), nft = testKeypair(2);
const wallet = payer.publicKey.toBase58();
const poolId = testKeypair(42).publicKey.toBase58();
const pair: OpenPositionPair = { poolAddress: poolId, mintA: testKeypair(8).publicKey.toBase58(), mintB: testKeypair(9).publicKey.toBase58(),
  symbolA: "AAA", symbolB: "BBB", wrappedSymbol: "AAAx", plainSymbol: "AAA", feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false };
let currentPair: OpenPositionPair;
let ledger: unknown[];
let controller: ReturnType<typeof useOpenPositionController>;
let root: Root, container: HTMLDivElement;
let sendMode: "ok" | "lost" | "unsent";
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
  useEffect(() => { controller = value; const { submitStage, signature, positionMint, error, actionDisabled, quote, quoteError, quoteLoading } = value;
    ledger.push([Date.now(), "commit", { submitStage, signature, positionMint, error, actionDisabled, quote, quoteError, quoteLoading }]); });
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
  sendMode = "ok"; preparedOverride = null; prepareWait = null; mocks.signAndSend = undefined; resetTxNotices();
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
    if (url === "/api/tx-send") {
      if (sendMode === "lost") throw new Error("socket hang up");
      if (sendMode === "unsent") return Response.json({ error: "Simulation failed: insufficient funds", sent: false }, { status: 400 });
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      // Phantom signs first; the new position mint co-signs the wallet-returned bytes.
      expect(tx.signatures[0]?.some((byte: number) => byte !== 0)).toBe(true);
      expect(tx.signatures[1]?.some((byte: number) => byte !== 0)).toBe(true);
      return Response.json({ signature: bs58.encode(tx.signatures[0]!) });
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
const settle = async (status: "confirmed" | "failed" | "expired") => {
  await act(async () => { settleTxNotice(noticeIdFor(controller.signature), status); }); await advance(1);
};
describe("open-position transaction lifecycle (shared pipeline)", () => {
  it("revokes a saved submit command on a parity change and passes the new setting to prepare", async () => {
    await mount();
    expect(controller.centerOnParity).toBe(true);
    const oldSubmit = controller.signAndSend;
    await act(async () => controller.changeCenterOnParity(false));
    await act(async () => oldSubmit());
    expect(calls("/api/open-prepare")).toHaveLength(0);
    expect(mocks.sign).not.toHaveBeenCalled();
    await advance(450);
    const quoteRequest = calls("/api/open-quote").at(-1)!;
    expect(JSON.parse(String(quoteRequest[1]?.body))).toMatchObject({ centerOnParity: false });
    await act(async () => controller.signAndSend());
    const prepareRequest = calls("/api/open-prepare").at(-1)!;
    expect(JSON.parse(String(prepareRequest[1]?.body))).toMatchObject({ centerOnParity: false });
  });

  it("signs, relays once with the mint co-signature, and stays pending until the signature confirms", async () => {
    await mount(); expect(controller.actionDisabled).toBe(false);
    await act(async () => controller.signAndSend()); await advance(1);
    expect(calls("/api/tx-send")).toHaveLength(1);
    expect(controller.submitStage).toBe("pending"); expect(controller.signature).not.toBe(""); expect(controller.actionDisabled).toBe(true);
    await settle("confirmed");
    expect(controller.submitStage).toBe("confirmed"); expect(controller.error).toBe("");
    await act(async () => controller.createAnother()); await advance(450);
    expect(controller.actionDisabled).toBe(false);
  });
  it("never uses wallet signAndSend for open, because the mint must co-sign after the wallet", async () => {
    mocks.signAndSend = vi.fn(async () => bs58.encode(new Uint8Array(64).fill(9)));
    await mount(); await act(async () => controller.signAndSend()); await advance(1);
    expect(mocks.signAndSend).not.toHaveBeenCalled(); expect(calls("/api/tx-send")).toHaveLength(1);
  });
  it.each(["failed", "expired"] as const)("reports %s in plain words and offers a fresh try", async status => {
    await mount(); await act(async () => controller.signAndSend()); await advance(1);
    await settle(status); await advance(450);
    expect(controller.submitStage).toBe(status); expect(controller.actionDisabled).toBe(false); expect(controller.signature).not.toBe("");
  });
  it("a definite unsent refusal frees the button and never tracks a signature", async () => {
    await mount(); sendMode = "unsent";
    await act(async () => controller.signAndSend()); await advance(450);
    expect(controller.error).toMatch(/nothing was sent|insufficient/i); expect(controller.actionDisabled).toBe(false);
    expect(controller.submitStage).not.toBe("pending");
  });
  it("a lost relay response is tracked by signature, not re-signed", async () => {
    await mount(); sendMode = "lost";
    await act(async () => controller.signAndSend()); await advance(1);
    expect(controller.submitStage).toBe("pending"); expect(controller.actionDisabled).toBe(true);
    await act(async () => controller.signAndSend());
    expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it("rejects a mismatched prepared selection before wallet signing", async () => {
    await mount(); preparedOverride = value => { value.summary.poolId = pair.mintA; };
    await act(async () => controller.signAndSend());
    expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/tx-send")).toHaveLength(0);
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
    expect(controller.error).toMatch(/timed out|retry|try again/i);
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
    expect(mocks.sign).not.toHaveBeenCalled(); expect(calls("/api/tx-send")).toHaveLength(0);
  });
  it("does not relay a signature approved after the modal unmounts", async () => {
    await mount(); let release!: (tx: VersionedTransaction) => void;
    let signed!: VersionedTransaction;
    mocks.sign.mockImplementation((tx: VersionedTransaction) => { tx.sign([payer]); signed = tx; return new Promise(resolve => { release = resolve; }); });
    let sending!: Promise<void>;
    await act(async () => { sending = controller.signAndSend(); });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => { release(signed); await sending; });
    expect(calls("/api/tx-send")).toHaveLength(0);
  });
  it("aborts when the wallet modifies the message and never mint-signs or relays", async () => {
    await mount();
    mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
      tx.message.recentBlockhash = "11111111111111111111111111111111";
      tx.sign([payer]);
      return tx;
    });
    await act(async () => controller.signAndSend());
    expect(calls("/api/tx-send")).toHaveLength(0);
    expect(controller.error).not.toBe("");
  });
  it("relays after the wallet appends a Lighthouse instruction", async () => {
    await mount();
    mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
      const extra = appendWalletExtraInstruction(tx);
      extra.sign([payer]);
      return extra;
    });
    await act(async () => controller.signAndSend());
    expect(calls("/api/tx-send")).toHaveLength(1);
    expect(controller.error).toBe("");
  });
});

describe("native SOL on SOL/hSOL vs a stock pool", () => {
  const sol = { kind: "native" as const, mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true, reason: null };
  const wsol = { kind: "token" as const, mint: NATIVE_SOL_MINT, decimals: 9, balance: "500000000", eligible: true, reason: null };
  const usdc = { kind: "token" as const, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, balance: "1000000", eligible: true, reason: null };
  const hsol = { kind: "token" as const, mint: HSOL_MINT, decimals: 9, balance: "200000000", eligible: true, reason: null };
  const solHsol: OpenPositionPair = {
    poolAddress: SOL_HSOL_CLMM_POOL_ID, mintA: NATIVE_SOL_MINT, mintB: HSOL_MINT,
    symbolA: "SOL", symbolB: "hSOL", wrappedSymbol: "SOL", plainSymbol: "hSOL",
    feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false,
  };
  const stock: OpenPositionPair = {
    poolAddress: "spcx-pool", mintA: "spcx-mint", mintB: "spcxx-mint",
    symbolA: "SPCX", symbolB: "SPCXx", wrappedSymbol: "SPCXx", plainSymbol: "SPCX",
    feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false,
  };
  function installAssets(assets: unknown[]) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/wallet")) return Response.json({ assets });
      if (url === "/api/open-quote") return Response.json(prepared().summary.quote);
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it("marks native SOL ineligible on SOL/hSOL and keeps token wSOL eligible", async () => {
    currentPair = solHsol;
    installAssets([sol, wsol, usdc, hsol]);
    await mount();
    const native = controller.inputAssets.find((item) => item.kind === "native");
    const wrapped = controller.inputAssets.find((item) => item.kind === "token" && item.mint === NATIVE_SOL_MINT);
    expect(native).toMatchObject({ eligible: false, reason: SOL_POOL_NATIVE_INPUT_MESSAGE });
    expect(wrapped).toMatchObject({ eligible: true, reason: null });
    expect(controller.inputKind).toBe("token");
    expect(controller.inputMint).not.toBeUndefined();
    expect(controller.selectedAsset?.kind).toBe("token");
  });

  it("still offers native SOL on a stock pool (SPCXx/SPCX)", async () => {
    currentPair = stock;
    installAssets([sol, usdc]);
    await mount();
    const native = controller.inputAssets.find((item) => item.kind === "native");
    expect(native).toMatchObject({ eligible: true, reason: null });
    expect(controller.inputAssets.some((item) => item.kind === "native" && item.eligible)).toBe(true);
  });
});
