// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import SignPage from "@/app/app/sign/[token]/page";
import type { PendingSignPayload } from "@/lib/pending-sign-token";
import { buildTransaction, openSummaryFixture, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";

const mocks = vi.hoisted(() => ({ wallet: "", sign: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/sign/browser-mint-token", useParams: () => ({ token: "browser-mint-token" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.wallet, connected: true, signTransaction: mocks.sign, connect: vi.fn(), disconnect: vi.fn() }) }));

const payer = testKeypair(1), placeholder = testKeypair(3), wallet = payer.publicKey.toBase58();
let root: Root, container: HTMLDivElement;
let payload: PendingSignPayload, events: string[], prepareBodies: Array<{ token: string; nftMint: string }>;
let reprepared: { unsignedTransaction: string; permit: string; sendPermit: string; summary: ReturnType<typeof openSummaryFixture> } | undefined;
let broadcastBody: Record<string, unknown> | undefined, prepareFails: boolean;
const signButton = () => [...container.querySelectorAll("button")].find(b => b.textContent === "Sign and submit");
async function mount() { await act(async () => root.render(createElement(SignPage))); await act(async () => vi.advanceTimersByTimeAsync(1)); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1700000000000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear(); mocks.wallet = wallet; mocks.sign.mockReset();
  events = []; prepareBodies = []; reprepared = undefined; broadcastBody = undefined; prepareFails = false;
  const preview = buildTransaction({ payer, extraSigners: [placeholder], signWith: [] });
  const summary = openSummaryFixture({ wallet, nftMint: placeholder.publicKey.toBase58(), blockhash: preview.message.recentBlockhash });
  payload = { kind: "open-position", wallet, unsignedTransaction: toBase64(preview), permit: "preview-permit", expiresAt: Date.now() + 60000,
    submitArgs: { wallet, permit: "preview-permit", summary },
    openRequest: { selection: { poolId: summary.poolId, inputMint: summary.inputMint, inputKind: "token" }, amount: "1", range: { preset: "standard" }, floorBps: 9900, toleranceBps: 100 } };
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => {
    events.push("wallet");
    expect(tx.signatures.every(sig => sig.every(byte => byte === 0))).toBe(true); // nothing pre-signed before the wallet
    const signed = VersionedTransaction.deserialize(tx.serialize()); signed.sign([payer]); return signed;
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url === "/api/verify-sign-token") return Response.json(payload);
    if (url === "/api/transaction-finality") return Response.json({ status: "pending" });
    if (url === "/api/sign-open-prepare") {
      events.push("prepare"); prepareBodies.push(body);
      if (prepareFails) return Response.json({ error: "Jupiter unavailable" }, { status: 503 });
      const mint = new PublicKey(body.nftMint);
      const tx = buildTransaction({ payer, extraSigners: [{ publicKey: mint } as Keypair], signWith: [] });
      reprepared = { unsignedTransaction: toBase64(tx), permit: "fresh-permit", sendPermit: "f".repeat(64), summary: openSummaryFixture({ wallet, nftMint: mint.toBase58(), blockhash: tx.message.recentBlockhash }) };
      return Response.json(reprepared);
    }
    if (url === "/api/tx-send") {
      events.push("broadcast"); broadcastBody = body;
      const signed = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      return Response.json({ signature: (await import("bs58")).default.encode(signed.signatures[0]!) });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => vi.advanceTimersByTimeAsync(5000)); await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it("generates the NFT mint in the browser, wallet signs first, mint signs the wallet-returned tx", async () => {
  await mount();
  expect(container.textContent).toContain("Created in your browser when you sign");
  await act(async () => signButton()!.click()); await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(events.slice(0, 3)).toEqual(["prepare", "wallet", "broadcast"]);
  expect(prepareBodies).toHaveLength(1);
  expect(prepareBodies[0]!.token).toBe("browser-mint-token");
  expect(Object.keys(prepareBodies[0]!).sort()).toEqual(["nftMint", "token"]); // only the public key leaves the browser
  expect(prepareBodies[0]!.nftMint).not.toBe(placeholder.publicKey.toBase58());
  const signed = VersionedTransaction.deserialize(Buffer.from(String(broadcastBody!.signedTransaction), "base64"));
  const message = signed.message.serialize();
  expect(nacl.sign.detached.verify(message, signed.signatures[0]!, payer.publicKey.toBytes())).toBe(true);
  expect(nacl.sign.detached.verify(message, signed.signatures[1]!, new PublicKey(prepareBodies[0]!.nftMint).toBytes())).toBe(true);
  // The relay carries the signed bytes plus the re-prepared transaction and the permit issued for it
  // (not the token's preview permit); the position mint in them is the browser-generated one.
  expect(Object.keys(broadcastBody!)).toEqual(["signedTransaction", "unsignedTransaction", "sendPermit"]);
  expect(broadcastBody!.sendPermit).toBe("f".repeat(64));
  expect(broadcastBody!.unsignedTransaction).toBe(reprepared!.unsignedTransaction);
  expect(signed.message.staticAccountKeys[1]!.toBase58()).toBe(prepareBodies[0]!.nftMint);
  expect(reprepared).toBeDefined();
  expect(container.textContent).toContain("Transaction submitted successfully");
});

it("does not ask the wallet to sign when the browser-mint re-prepare fails", async () => {
  prepareFails = true;
  await mount(); await act(async () => signButton()!.click()); await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(events).toEqual(["prepare"]); expect(mocks.sign).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Jupiter unavailable");
});
