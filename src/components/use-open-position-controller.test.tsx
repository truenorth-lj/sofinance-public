// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { openAttemptKey, persistOpenAttempt } from "@/lib/open-attempt";
import { buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
const mocks = vi.hoisted(() => ({ address: "", sign: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.address, connected: true, signTransaction: mocks.sign }) }));
const payer = testKeypair(1), nft = testKeypair(2);
const wallet = payer.publicKey.toBase58();
const poolId = testKeypair(42).publicKey.toBase58();
const pair: OpenPositionPair = { poolAddress: poolId, mintA: testKeypair(8).publicKey.toBase58(), mintB: testKeypair(9).publicKey.toBase58(),
  symbolA: "AAA", symbolB: "BBB", wrappedSymbol: "AAAx", plainSymbol: "AAA", feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false };
let controller: ReturnType<typeof useOpenPositionController>;
let root: Root, container: HTMLDivElement;
let chainStatus: string, sendMode: "ok" | "lost" | "unsent";
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
  const value = useOpenPositionController(pair);
  useEffect(() => { controller = value; });
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
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear(); mocks.address = wallet;
  chainStatus = "pending"; sendMode = "ok"; verificationError = false; preparedOverride = null; prepareWait = null;
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([payer]); return tx; });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.startsWith("/api/wallet")) return Response.json({ assets: [{ kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "1000000000", eligible: true }] });
    if (url === "/api/open-quote") return Response.json(prepared().summary.quote);
    if (url === "/api/open-prepare") {
      if (prepareWait) return prepareWait;
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
      return Response.json({ signature: bs58.encode(tx.signatures[0]!), positionMint: tx.message.staticAccountKeys[1]!.toBase58() });
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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
    expect(controller.error).toContain("Wallet modified transaction content");
  });
});
