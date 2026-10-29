// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// These suites drive the open flow with native SOL input; keep them exercising the
// SOL path regardless of the temporary SOL_INPUT_ENABLED switch (see feature-flags.ts).
const solInputFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/feature-flags")>(),
  get SOL_INPUT_ENABLED() { return solInputFlag.enabled; },
}));
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { openAttemptKey } from "@/lib/open-attempt";
import { buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
const mocks = vi.hoisted(() => ({ address: "", sign: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.address, connected: true, signTransaction: mocks.sign }) }));
const payer = testKeypair(1), nft = testKeypair(2);
const wallet = payer.publicKey.toBase58();
const poolId = testKeypair(42).publicKey.toBase58();
const pair: OpenPositionPair = { poolAddress: poolId, mintA: testKeypair(8).publicKey.toBase58(), mintB: testKeypair(9).publicKey.toBase58(),
  symbolA: "AAA", symbolB: "BBB", wrappedSymbol: "AAAx", plainSymbol: "AAA", feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false };
let secrets: Array<() => Uint8Array>;
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
  const quote = { ...summary.quote, poolId, inputMint: NATIVE_SOL_MINT, inputKind: "native", inputDecimals: 9 };
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
  secrets = [];
  const generate = Keypair.generate;
  vi.spyOn(Keypair, "generate").mockImplementation(() => { const key = generate(); secrets.push(() => key.secretKey); return key; });
  const keyPair = nacl.sign.keyPair;
  vi.spyOn(nacl.sign, "keyPair").mockImplementation(() => { const key = keyPair(); const secret = key.secretKey; secrets.push(() => secret); return key; });
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
    if (url.startsWith("/api/wallet")) return Response.json({ assets: [{ kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true }] });
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
      expect(secrets).toHaveLength(1);
      expect(secrets[0]!().every(byte => byte === 0)).toBe(true);
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
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  const cleared = secrets.every(read => read().every(byte => byte === 0));
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  // Only booleans are asserted/logged: never disclose even synthetic secret bytes.
  expect(cleared).toBe(true);
});

it("clears the owned mint before broadcast while preserving valid wallet and mint signatures", async () => {
  await mount();
  await act(async () => controller.signAndSend());
  expect(secrets).toHaveLength(1); expect(controller.error).toBe("");
  expect(calls("/api/open-broadcast")).toHaveLength(1);
  const body = JSON.parse(String(calls("/api/open-broadcast")[0]![1].body));
  const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
  const originalWalletTx = VersionedTransaction.deserialize(Buffer.from(body.unsignedTransaction, "base64"));
  originalWalletTx.sign([payer]);
  expect(tx.signatures[0]).toEqual(originalWalletTx.signatures[0]);
  for (let i = 0; i < 2; i++) expect(nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[i]!, tx.message.staticAccountKeys[i]!.toBytes())).toBe(true);
});

it.each(["prepare", "wallet", "mint-sign", "serialize", "stale-prepare", "stale-wallet", "unmount"] as const)("clears the mint on %s failure/cancellation without sending", async failure => {
  await mount();
  if (failure === "prepare") preparedOverride = () => { throw new Error("synthetic prepare failure"); };
  if (failure === "stale-prepare") preparedOverride = () => controller.changeAmount("0.003");
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
    if (failure === "wallet") throw new Error("User rejected request");
    tx.sign([payer]);
    if (failure === "mint-sign") vi.spyOn(tx, "sign").mockImplementation(() => { throw new Error("synthetic mint signing failure"); });
    if (failure === "serialize") {
      const serialize = tx.serialize.bind(tx);
      vi.spyOn(tx, "serialize").mockImplementation(() => {
        // The wallet guard also serializes before mint signing; fail only on final bytes.
        if (tx.signatures[1]?.some(byte => byte !== 0)) {
          expect(secrets[0]!().every(byte => byte === 0)).toBe(true);
          throw new Error("synthetic serialization failure");
        }
        return serialize();
      });
    }
    if (failure === "stale-wallet") controller.changeAmount("0.003");
    if (failure === "unmount") { root.unmount(); root = createRoot(container); }
    return tx;
  });
  await act(async () => controller.signAndSend());
  expect(secrets).toHaveLength(1);
  expect(calls("/api/open-broadcast")).toHaveLength(0);
  expect(window.localStorage.getItem(openAttemptKey(wallet))).toBeNull();
  expect(secrets[0]!().every(byte => byte === 0)).toBe(true);
  if (failure === "serialize") expect(controller.error).toContain("synthetic serialization failure");
});

it("releases the operation lock if mint initialization throws", async () => {
  await mount();
  vi.mocked(nacl.sign.keyPair).mockImplementationOnce(() => { throw new Error("synthetic entropy failure"); });
  await act(async () => controller.signAndSend());
  expect(controller.submitStage).toBeNull();
  expect(controller.error).toContain("synthetic entropy failure");
  expect(calls("/api/open-prepare")).toHaveLength(0);
  await act(async () => controller.signAndSend());
  expect(calls("/api/open-broadcast")).toHaveLength(1);
});
