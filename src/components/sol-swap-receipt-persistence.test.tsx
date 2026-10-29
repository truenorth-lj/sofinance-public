// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Step 1/2 receipt persistence: a landed SOL -> pool-token swap must stay resumable as
// "Continue open (2/2)" across form edits, modal close/reload, until it is consumed,
// expires, is dismissed, or the wallet switches. It never leaks across wallets or pools.
const solInputFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/feature-flags")>(),
  get SOL_INPUT_ENABLED() { return solInputFlag.enabled; },
}));
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { openAttemptKey, persistOpenAttempt } from "@/lib/open-attempt";
import { buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { SOL_SWAP_RECEIPT_TTL_MS, solSwapReceiptKey, type PendingSolSwapReceipt } from "./transactions/open/sol-swap-receipt-store";

const mocks = vi.hoisted(() => ({ address: "", sign: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.address, connected: true, signTransaction: mocks.sign }) }));
const payer = testKeypair(1), otherPayer = testKeypair(3);
const wallet = payer.publicKey.toBase58(), otherWallet = otherPayer.publicKey.toBase58();
const poolId = testKeypair(42).publicKey.toBase58();
const pair: OpenPositionPair = { poolAddress: poolId, mintA: testKeypair(8).publicKey.toBase58(), mintB: testKeypair(9).publicKey.toBase58(),
  symbolA: "AAA", symbolB: "BBB", wrappedSymbol: "AAAx", plainSymbol: "AAA", feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false };
const otherPair: OpenPositionPair = { ...pair, poolAddress: testKeypair(43).publicKey.toBase58() };
const swapSignature = bs58.encode(new Uint8Array(64).fill(7));
let currentPair: OpenPositionPair;
let controller: ReturnType<typeof useOpenPositionController>;
let root: Root, container: HTMLDivElement;
let chainStatus: string;
let prepareFails: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

function receipt(over: Partial<PendingSolSwapReceipt> = {}): PendingSolSwapReceipt {
  return { wallet, poolId, signature: swapSignature, outputMint: pair.mintA, outputSymbol: "AAA", delivered: "695", decimals: 6,
    landedAt: Date.now(), ...over };
}
const stored = (w = wallet, p = poolId) => {
  const raw = window.localStorage.getItem(solSwapReceiptKey(w, p));
  return raw === null ? null : JSON.parse(raw) as PendingSolSwapReceipt;
};
function preparedOpen(nftMint: PublicKey, body: Record<string, unknown>) {
  const tx = buildTransaction({ payer, extraSigners: [{ publicKey: nftMint, secretKey: new Uint8Array(64) } as ReturnType<typeof testKeypair>], signWith: [] });
  const summary = openSummaryFixture({ wallet, nftMint: nftMint.toBase58(), blockhash: tx.message.recentBlockhash });
  const requested = body.inputKind === "token" && body.inputMint === pair.mintA ? "695" : summary.quote.requested;
  const quote = { ...summary.quote, poolId, inputMint: body.inputMint, inputKind: body.inputKind, inputDecimals: 6, requested };
  return { unsignedTransaction: toBase64(tx), permit: "test-permit", summary: { ...summary, quote } };
}
function Harness() {
  const value = useOpenPositionController(currentPair);
  useEffect(() => { controller = value; });
  return null;
}
const calls = (url: string) => fetchMock.mock.calls.filter(([path]) => path === url);
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() {
  await act(async () => root.render(createElement(Harness)));
  await advance(1);
  await act(async () => controller.changeAmount("0.002"));
  await advance(450);
}
async function reload() {
  await act(async () => root.unmount()); root = createRoot(container);
  await mount();
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000); currentPair = pair; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear(); mocks.address = wallet; chainStatus = "pending"; prepareFails = false;
  mocks.sign.mockReset();
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([payer]); return tx; });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.startsWith("/api/wallet")) return Response.json({ assets: [
      { kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true },
      { kind: "token", mint: pair.mintA, decimals: 6, balance: "1000000", eligible: true },
    ] });
    if (url === "/api/open-quote") {
      return Response.json(preparedOpen(testKeypair(2).publicKey, { inputMint: body.inputMint, inputKind: body.inputKind }).summary.quote);
    }
    if (url === "/api/sol-swap-prepare") {
      const tx = buildTransaction({ payer, signWith: [] });
      return Response.json({ unsignedTransaction: toBase64(tx), permit: "p", summary: { operation: "sol-swap-step", wallet, poolId,
        requested: "2000000", outputMint: pair.mintA, outputSymbol: "AAA", blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: 9, expiresAt: Date.now() + 60_000 } });
    }
    if (url === "/api/sol-swap-broadcast") {
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      return Response.json({ signature: bs58.encode(tx.signatures[0]!) });
    }
    if (url === "/api/sol-swap-status") return Response.json({ status: "confirmed", delivered: "695", decimals: 6 });
    if (url === "/api/open-prepare") {
      if (prepareFails) return Response.json({ error: "Jupiter route unavailable" }, { status: 502 });
      return Response.json(preparedOpen(new PublicKey(body.nftMint), body));
    }
    if (url === "/api/open-broadcast") {
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      return Response.json({ signature: bs58.encode(tx.signatures[0]!), beamLabel: null, positionMint: tx.message.staticAccountKeys[1]!.toBase58() });
    }
    if (url === "/api/open-status") return Response.json({ signature: body.attempt.signature, status: chainStatus });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("step 1/2 receipt persistence", () => {
  it("persists a landed step 1/2 when step 2/2 fails, and keeps it through amount, asset and range edits", async () => {
    await mount();
    await act(async () => controller.chooseAsset("native", NATIVE_SOL_MINT)); await advance(450);
    await act(async () => controller.changeAmount("0.002")); await advance(450);
    prepareFails = true;
    await act(async () => controller.signAndSend()); await advance(1);
    expect(calls("/api/sol-swap-broadcast")).toHaveLength(1);
    expect(controller.error).toContain("Step 1/2 done");
    expect(controller.pendingSwap?.delivered).toBe("695");
    expect(stored()).toMatchObject({ wallet, poolId, delivered: "695", outputMint: pair.mintA });
    const swapSig = controller.pendingSwap!.signature;
    await act(async () => controller.changeAmount("0.5")); await advance(450);
    await act(async () => controller.chooseAsset("token", pair.mintA)); await advance(450);
    await act(async () => controller.choosePreset("wide")); await advance(450);
    expect(controller.pendingSwap?.signature).toBe(swapSig);
    expect(stored()?.signature).toBe(swapSig);
    expect(controller.actionDisabled).toBe(false);
    // Resuming opens exactly the delivered amount with the step-1 signature and the newly chosen range; no second swap.
    prepareFails = false;
    await act(async () => controller.signAndSend()); await advance(1);
    expect(calls("/api/sol-swap-prepare")).toHaveLength(1);
    const last = bodyOf(calls("/api/open-prepare").at(-1)!);
    expect(last).toMatchObject({ inputMint: pair.mintA, inputKind: "token", amount: "0.000695", solSwapSignature: swapSig, rangePreset: "wide" });
  });

  it("survives a reload (remount) and resumes with the stored receipt", async () => {
    window.localStorage.setItem(solSwapReceiptKey(wallet, poolId), JSON.stringify(receipt()));
    await mount();
    expect(controller.pendingSwap?.signature).toBe(swapSignature);
    await reload();
    expect(controller.pendingSwap?.signature).toBe(swapSignature);
    expect(controller.solTwoStep).toBe(true);
    await act(async () => controller.signAndSend()); await advance(1);
    expect(calls("/api/sol-swap-prepare")).toHaveLength(0);
    expect(bodyOf(calls("/api/open-prepare")[0]!)).toMatchObject({ amount: "0.000695", solSwapSignature: swapSignature, inputKind: "token" });
  });

  it("expires with the 30-minute fee credit", async () => {
    window.localStorage.setItem(solSwapReceiptKey(wallet, poolId), JSON.stringify(receipt()));
    await mount();
    expect(controller.pendingSwap).not.toBeNull();
    await advance(SOL_SWAP_RECEIPT_TTL_MS);
    expect(controller.pendingSwap).toBeNull();
    expect(stored()).toBeNull();
    // An already-expired record is never hydrated.
    window.localStorage.setItem(solSwapReceiptKey(wallet, poolId), JSON.stringify(receipt({ landedAt: Date.now() - SOL_SWAP_RECEIPT_TTL_MS })));
    await reload();
    expect(controller.pendingSwap).toBeNull();
    expect(stored()).toBeNull();
  });

  it("is cleared after its step 2/2 open confirms", async () => {
    window.localStorage.setItem(solSwapReceiptKey(wallet, poolId), JSON.stringify(receipt()));
    await mount();
    await act(async () => controller.signAndSend()); await advance(1);
    expect(controller.submitStage).toBe("pending");
    expect(stored()?.openSignature).toBe(controller.signature);
    chainStatus = "confirmed"; await advance(3000);
    expect(controller.submitStage).toBe("confirmed");
    expect(controller.pendingSwap).toBeNull();
    expect(stored()).toBeNull();
    await reload();
    expect(controller.pendingSwap).toBeNull();
  });

  it("is not consumed by an older confirmed open on the same pool", async () => {
    const older = preparedOpen(testKeypair(5).publicKey, { inputMint: pair.mintB, inputKind: "token" }).summary;
    persistOpenAttempt(window.localStorage, { version: 1, wallet, signature: bs58.encode(new Uint8Array(64).fill(9)), nftMint: older.nftMint,
      positionAccount: older.positionAccount, poolId, tickLower: -60, tickUpper: 60, liquidity: "777", blockhash: older.blockhash,
      lastValidBlockHeight: 150, createdAt: Date.now() - 60_000 });
    chainStatus = "confirmed";
    window.localStorage.setItem(solSwapReceiptKey(wallet, poolId), JSON.stringify(receipt()));
    await mount(); await advance(3000);
    expect(window.localStorage.getItem(openAttemptKey(wallet))).not.toBeNull();
    expect(controller.pendingSwap?.signature).toBe(swapSignature);
    expect(stored()).not.toBeNull();
  });

  it("is never offered for another wallet or another pool, and a wallet switch drops it", async () => {
    window.localStorage.setItem(solSwapReceiptKey(wallet, poolId), JSON.stringify(receipt()));
    currentPair = otherPair;
    await mount();
    expect(controller.pendingSwap).toBeNull();
    currentPair = pair;
    await act(async () => root.render(createElement(Harness))); await advance(1);
    expect(controller.pendingSwap?.signature).toBe(swapSignature);
    mocks.address = otherWallet;
    await act(async () => root.render(createElement(Harness))); await advance(450);
    expect(controller.pendingSwap).toBeNull();
    expect(stored()).toBeNull();
    // A transient disconnect (reload, adapter reconnect) keeps it.
    window.localStorage.setItem(solSwapReceiptKey(otherWallet, poolId), JSON.stringify(receipt({ wallet: otherWallet })));
    mocks.address = "";
    await act(async () => root.render(createElement(Harness))); await advance(1);
    mocks.address = otherWallet;
    await act(async () => root.render(createElement(Harness))); await advance(1);
    expect(controller.pendingSwap?.wallet).toBe(otherWallet);
  });

  it("can be dismissed, after which a normal open is offered", async () => {
    window.localStorage.setItem(solSwapReceiptKey(wallet, poolId), JSON.stringify(receipt()));
    await mount();
    await act(async () => controller.dismissPendingSwap());
    expect(controller.pendingSwap).toBeNull();
    expect(stored()).toBeNull();
    await reload();
    expect(controller.pendingSwap).toBeNull();
  });
});
