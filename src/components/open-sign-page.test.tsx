// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import SignPage from "@/app/app/sign/[token]/page";
import { openAttemptFromSummary, openAttemptKey, persistOpenAttempt } from "@/lib/open-attempt";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";
import type { PendingSignPayload } from "@/lib/pending-sign-token";
import { buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
const mocks = vi.hoisted(() => ({ wallet: "", sign: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/sign/synthetic-token", useParams: () => ({ token: "synthetic-token" }), useRouter: () => ({ push: mocks.push }) }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.wallet, connected: true, signTransaction: mocks.sign, connect: vi.fn(), disconnect: vi.fn() }) }));
const payer = testKeypair(1), nft = testKeypair(2), wallet = payer.publicKey.toBase58();
let root: Root, container: HTMLDivElement, storage: Storage;
let payload: PendingSignPayload, sendMode: "ok" | "unknown" | "mismatch" | "unsent";
let chainStatus: string, ledger: unknown[], broadcasts: number, failStorage: boolean;
const record = (...args: unknown[]) => ledger.push([Date.now(), ...args]);
const signButton = () => [...container.querySelectorAll("button")].find(b => b.textContent === "Sign and submit");
async function advance(ms = 1) { await act(async () => vi.advanceTimersByTimeAsync(ms)); record("ui", container.textContent); }
async function mount() { await act(async () => root.render(createElement(SignPage))); record("ui-before-load", container.textContent); await advance(); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.wallet = wallet; mocks.push.mockReset(); mocks.sign.mockReset(); ledger = []; broadcasts = 0; failStorage = false;
  storage = window.localStorage; storage.clear(); sendMode = "ok"; chainStatus = "pending";
  const tx = buildTransaction({ payer, extraSigners: [nft], signWith: [nft] });
  const summary = openSummaryFixture({ wallet, nftMint: nft.publicKey.toBase58(), blockhash: tx.message.recentBlockhash });
  payload = { kind: "open-position", wallet, unsignedTransaction: toBase64(tx), permit: "synthetic-permit", expiresAt: Date.now() + 60000,
    submitArgs: { wallet, permit: "synthetic-permit", summary } } as PendingSignPayload;
  vi.spyOn(window, "localStorage", "get").mockReturnValue({
    getItem: (key: string) => { record("get", key); return storage.getItem(key); },
    setItem: (key: string, raw: string) => { record("set", key, raw); if (failStorage) throw new Error("storage denied"); storage.setItem(key, raw); },
    removeItem: (key: string) => { record("remove", key); storage.removeItem(key); },
  } as Storage);
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
    record("wallet-input", toBase64(tx)); const signed = VersionedTransaction.deserialize(tx.serialize()); signed.sign([payer]);
    // Wallet drops the NFT slot; real page must restore the original partial signature.
    signed.signatures[1] = new Uint8Array(64); record("wallet-output", toBase64(signed)); return signed;
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    record("fetch", url, init?.body); const body = JSON.parse(String(init?.body));
    if (url === "/api/verify-sign-token") return Response.json(payload);
    if (url === "/api/open-status") return Response.json({ signature: body.attempt.signature, status: chainStatus });
    if (["/api/open-broadcast", "/api/selected-broadcast", "/api/compound-broadcast", "/api/withdraw-broadcast"].includes(url)) {
      broadcasts++; const signed = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64")); const sig = bs58.encode(signed.signatures[0]!);
      expect(Buffer.from(signed.message.serialize())).toEqual(Buffer.from(tx.message.serialize()));
      if (payload.kind === "open-position") {
        expect(signed.signatures[1]).toEqual(tx.signatures[1]); expect(storage.getItem(openAttemptKey(wallet))).toContain(sig);
        expect(body).toEqual({ signedTransaction: toBase64(signed), ...payload.submitArgs });
      } else expect(storage.getItem(openAttemptKey(wallet))).toBe("broken");
      if (sendMode === "unknown") throw new Error("lost response");
      if (sendMode === "unsent") return Response.json({ error: "preflight", sent: false }, { status: 400 });
      return Response.json({ signature: sendMode === "mismatch" ? "wrong" : sig });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async context => {
  // The existing page schedules its redirect after acceptance; drain it explicitly before teardown.
  await advance(5000); record("redirect", mocks.push.mock.calls); await act(async () => root.unmount()); container.remove();
  record("storage", Object.fromEntries(Object.keys(storage).sort().map(k => [k, storage.getItem(k)])));
  record("counts", { signs: mocks.sign.mock.calls.length, broadcasts }); expect(vi.getTimerCount()).toBe(0);
  // eslint-disable-next-line no-console -- Raw before/after characterization evidence.
  console.log("OPEN_SIGN_LEDGER " + JSON.stringify({ name: context.task.name, ledger }));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
describe("real SIGN page with real Open attempt boundary", () => {
  it.each(["ok", "unknown", "mismatch", "unsent"] as const)("preserves %s submission, original bytes and reload semantics", async mode => {
    sendMode = mode; await mount(); expect(signButton()).toBeDefined(); await act(async () => signButton()!.click()); await advance();
    expect(mocks.sign).toHaveBeenCalledTimes(1); expect(broadcasts).toBe(1);
    if (mode === "ok") expect(container.textContent).toContain("Transaction submitted successfully");
    else expect(container.textContent).toContain(mode === "unknown" ? "lost response" : mode === "mismatch" ? "signature mismatch" : "safe to retry");
    const raw = storage.getItem(openAttemptKey(wallet)); expect(raw === null).toBe(mode === "unsent");
    await advance(5000); await act(async () => root.unmount()); root = createRoot(container); await mount();
    expect(Boolean(signButton())).toBe(mode === "unsent"); expect(mocks.sign).toHaveBeenCalledTimes(1); expect(broadcasts).toBe(1);
    if (mode !== "unsent") { expect(container.textContent).toContain("Checking the original"); chainStatus = "failed"; await advance(3000); expect(signButton()).toBeDefined(); }
  });
  it("blocks invalid history and storage failure without broadcasting", async () => {
    storage.setItem(openAttemptKey(wallet), "broken"); await mount(); expect(signButton()).toBeUndefined(); expect(container.textContent).toContain("cannot be verified");
    await act(async () => root.unmount()); root = createRoot(container); storage.clear(); await mount(); failStorage = true;
    await act(async () => signButton()!.click()); expect(container.textContent).toContain("storage denied"); expect(broadcasts).toBe(0);
  });
  it.each(["manual-review", "confirmed", "failed", "expired"])("projects loaded %s history without automatically signing", async status => {
    chainStatus = status;
    const saved = openAttemptFromSummary(bs58.encode(new Uint8Array(64).fill(4)), payload.submitArgs.summary as OpenPositionSummary);
    storage.setItem(openAttemptKey(wallet), JSON.stringify(saved)); await mount(); await advance();
    expect(Boolean(signButton())).toBe(status !== "manual-review"); expect(mocks.sign).not.toHaveBeenCalled(); expect(broadcasts).toBe(0);
  });
  it.each(["compound", "add-liquidity", "withdraw"] as const)("keeps %s independent of Open durable history", async kind => {
    payload.kind = kind; payload.submitArgs.selection = { positionMint: nft.publicKey.toBase58() };
    (payload.submitArgs.summary as Record<string, unknown>).positionMint = nft.publicKey.toBase58();
    storage.setItem(openAttemptKey(wallet), "broken"); await mount(); expect(signButton()).toBeDefined();
    await act(async () => signButton()!.click()); expect(broadcasts).toBe(1); expect(container.textContent).toContain("Transaction submitted successfully");
    expect(ledger.some(event => JSON.stringify(event).includes('/api/open-status'))).toBe(false);
  });
});


it("late unsent SIGN response retains the newer receipt and avoids safe-retry advice", async () => {
  await mount(); const mock = vi.mocked(fetch), originalFetch = mock.getMockImplementation()!;
  let release!: (value: Response) => void;
  const waiting = new Promise<Response>(resolve => { release = resolve; });
  mock.mockImplementation((url, init) => url === "/api/open-broadcast" ? waiting : originalFetch(url, init));
  await act(async () => signButton()!.click());
  const key = openAttemptKey(wallet), raw = storage.getItem(key)!;
  const original = JSON.parse(raw), newer = { ...original, signature: bs58.encode(new Uint8Array(64).fill(44)) };
  persistOpenAttempt(storage, newer);
  await act(async () => { release(Response.json({ error: "preflight", sent: false }, { status: 400 })); });
  await advance();
  expect(container.textContent).not.toContain("safe to retry"); expect(signButton()).toBeUndefined();
  expect(container.textContent).toContain("Checking the original");
  expect(storage.getItem(key)).toBe(JSON.stringify(newer));
  expect(storage.getItem(key + ":history:" + original.signature)).toBe(raw);
  const statusRequests = mock.mock.calls.filter(([url]) => url === "/api/open-status");
  expect(statusRequests.some(([, init]) => JSON.parse(String(init?.body)).attempt.signature === newer.signature)).toBe(true);
  expect(mocks.sign).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount()); root = createRoot(container); mock.mockImplementation(originalFetch);
  chainStatus = "expired"; await mount(); await advance(); expect(signButton()).toBeDefined();
});
