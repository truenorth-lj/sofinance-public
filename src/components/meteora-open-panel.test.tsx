// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { MeteoraOpenPanel } from "./meteora-open-panel";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { meteoraPendingKey, METEORA_PENDING_KEY } from "@/lib/meteora-wallet/pending";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const owner = Keypair.fromSeed(new Uint8Array(32).fill(42));
const other = Keypair.fromSeed(new Uint8Array(32).fill(43));
const view = { poolId: other.publicKey.toBase58(), symbolX: "X", symbolY: "Y", mintX: other.publicKey.toBase58(), mintY: owner.publicKey.toBase58(), decimals: 8, binStep: 1, activeId: 0, allowedLowerBinId: -70, allowedUpperBinId: 69 };
let root: Root, container: HTMLDivElement, connection: WalletConnection;
let sends: unknown[], expectedSignature: string;
let send: () => Promise<Response>;
let status: "pending" | "confirmed" | "failed" | "expired";
let actions: string[];
const flush = () => vi.advanceTimersByTimeAsync(5);
const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
let selectedView = view;
const render = () => root.render(createElement(WalletConnectionContext.Provider, { value: connection }, createElement(MeteoraOpenPanel, { view: selectedView, signingEnabled: true })));
beforeEach(async () => {
  selectedView = view; vi.useFakeTimers(); status = "pending"; actions = [];
  const records = new Map<string, string>();
  const storage: Storage = { get length() { return records.size; }, key: i => [...records.keys()][i] ?? null,
    getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); },
    removeItem: key => { records.delete(key); }, clear: () => records.clear() };
  vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
  localStorage.clear(); sends = []; expectedSignature = "";
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  connection = { address: owner.publicKey.toBase58(), connected: true, connect() {}, disconnect() {}, isMobile: false, walletsCount: 1, connectionError: "",
    signTransaction: async tx => { tx.sign([owner]); expectedSignature = bs58.encode(tx.signatures[0]!); return tx; } };
  send = async () => Response.json({ error: "preflight rejected", sent: false }, { status: 422 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("/api/meteora-open");
    const body = JSON.parse(init.body as string); actions.push(body.action);
    if (body.action === "balances") return Response.json({ wallet: body.wallet, solLamports: "1000000000", usdc: "1000000", x: "0", y: "0" });
    if (body.action === "setup") {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: other.publicKey.toBase58(),
        instructions: [SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: new PublicKey(body.position), lamports: 1, space: 0, programId: SystemProgram.programId })] }).compileToV0Message());
      return Response.json({ ...body, transaction: Buffer.from(tx.serialize()).toString("base64"), permit: "mock", summary: { kind: "setup", wallet: body.wallet, poolId: body.poolId, position: body.position, blockhash: tx.message.recentBlockhash, expiresAt: Date.now() + 90_000, lastValidBlockHeight: 100 } });
    }
    if (body.action === "deposit" || body.action === "close") {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: other.publicKey.toBase58(),
        instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(body.position), lamports: body.action === "deposit" ? 0 : 1 })] }).compileToV0Message());
      return Response.json({ ...body, transaction: Buffer.from(tx.serialize()).toString("base64"), permit: "mock", summary: {
        kind: body.action, wallet: body.wallet, poolId: body.poolId, position: body.position, blockhash: tx.message.recentBlockhash, expiresAt: Date.now() + 90_000, lastValidBlockHeight: 100 } });
    }
    if (body.action === "status") return Response.json({ signature: body.signature, status });
    if (body.action === "send") {
      const signed = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      expect(JSON.parse(localStorage.getItem(meteoraPendingKey(body.summary.wallet))!)).toMatchObject({
        [`${body.summary.kind}Signature`]: bs58.encode(signed.signatures[0]!), [`${body.summary.kind}LastValidBlockHeight`]: 100 });
      sends.push(body); return send();
    }
    throw new Error(`Unexpected mock action ${body.action}`);
  }));
  await act(async () => { render(); await flush(); });
  await act(async () => { button("Prepare 1/2").click(); await flush(); });
  expect(button("Sign 1/2").disabled).toBe(false);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });

it("CONTROL: explicit pre-broadcast rejection permits retry", async () => {
  await act(async () => { button("Sign 1/2").click(); await flush(); });
  expect(sends).toHaveLength(1); expect(localStorage.getItem(meteoraPendingKey(owner.publicKey.toBase58()))).toBeNull();
});

it("SAFETY: lost HTTP response retains the locally known signature", async () => {
  send = async () => { throw new TypeError("Failed to fetch"); };
  await act(async () => { button("Sign 1/2").click(); await flush(); });
  expect(sends).toHaveLength(1); expect(expectedSignature).not.toBe("");
  expect(JSON.parse(localStorage.getItem(meteoraPendingKey(owner.publicKey.toBase58())) ?? "null")).toMatchObject({ setupSignature: expectedSignature, stage: "setup_submitted" });
});

it("SAFETY: signature is durable before the HTTP send can complete", async () => {
  let release!: (r: Response) => void;
  send = () => new Promise(r => { release = r; });
  await act(async () => { button("Sign 1/2").click(); await flush(); });
  const stored = JSON.parse(localStorage.getItem(meteoraPendingKey(owner.publicKey.toBase58())) ?? "null");
  await act(async () => { release(Response.json({ sent: false, error: "rejected" }, { status: 422 })); await flush(); });
  expect(stored).toMatchObject({ setupSignature: expectedSignature, setupLastValidBlockHeight: 100 });
});

it("SAFETY: wallet change during signing stops the old send", async () => {
  let release!: () => void;
  connection = { ...connection, signTransaction: async tx => { tx.sign([owner]); await new Promise<void>(r => { release = r; }); return tx; } };
  await act(async () => render());
  await act(async () => { button("Sign 1/2").click(); await flush(); });
  connection = { ...connection, address: other.publicKey.toBase58() };
  await act(async () => render());
  await act(async () => { release(); await flush(); });
  expect(sends).toHaveLength(0);
});

it("SAFETY: failed storage persistence prevents broadcast", async () => {
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  await act(async () => { button("Sign 1/2").click(); await flush(); });
  expect(sends).toHaveLength(0);
});

const click = async (label: string) => { await act(async () => { button(label).click(); await flush(); }); };
const key = () => meteoraPendingKey(owner.publicKey.toBase58());
const saved = () => JSON.parse(localStorage.getItem(key())!);
const stageButton = (kind: string) => kind === "setup" ? "Sign 1/2" : kind === "deposit" ? "Sign 2/2" : "Sign close and refund";
async function readyStage(kind: string) {
  if (kind === "setup") return;
  status = "confirmed"; send = async () => Response.json({ signature: expectedSignature });
  await click("Sign 1/2");
  expect(saved().stage).toBe("setup_confirmed");
  if (kind === "close") await click("Prepare close and refund");
  expect(button(stageButton(kind)).disabled).toBe(false);
  status = "pending";
}

it.each(["setup", "deposit", "close"])("keeps %s pending on invalid JSON, and reload rechecks without signing or resending", async kind => {
  await readyStage(kind);
  send = async () => new Response("proxy lost response", { status: 502 });
  await click(stageButton(kind));
  const signature = expectedSignature, count = sends.length;
  expect(saved()).toMatchObject({ stage: `${kind}_submitted`, [`${kind}Signature`]: signature });
  await act(async () => { root.render(null); await flush(); });
  status = "confirmed";
  await act(async () => render());
  await act(async () => { await flush(); });
  expect(sends).toHaveLength(count);
  expect(expectedSignature).toBe(signature);
  if (kind === "setup") expect(saved().stage).toBe("setup_confirmed");
  else expect(localStorage.getItem(key())).toBeNull();
});
it.each(["deposit", "close"])("only explicit unsent can restore the confirmed setup after a %s send", async kind => {
  await readyStage(kind); const previous = saved();
  send = async () => Response.json({ sent: false, error: "preflight rejected" }, { status: 422 });
  await click(stageButton(kind));
  expect(saved()).toEqual(previous);
});
it.each(["failed", "expired"] as const)("settles a chain-%s deposit without losing the confirmed setup", async outcome => {
  await readyStage("deposit"); const previous = saved();
  status = outcome; send = async () => Response.json({ signature: expectedSignature });
  await click("Sign 2/2");
  expect(saved()).toEqual(previous);
  expect(button("Sign 2/2").disabled).toBe(true);
});
it("preserves wallet A pending while wallet B uses an independent record", async () => {
  send = async () => { throw new Error("lost"); }; await click("Sign 1/2");
  const before = localStorage.getItem(key());
  connection = { ...connection, address: other.publicKey.toBase58() };
  await act(async () => { render(); await flush(); });
  expect(button("Prepare 1/2").disabled).toBe(false);
  expect(localStorage.getItem(key())).toBe(before);
  expect(localStorage.getItem(meteoraPendingKey(other.publicKey.toBase58()))).toBeNull();
});
it("blocks new work over malformed legacy storage", async () => {
  localStorage.setItem(METEORA_PENDING_KEY, "{bad");
  await act(async () => window.dispatchEvent(new Event("storage")));
  expect(button("Prepare 1/2").disabled).toBe(true);
  expect(button("Sign 1/2").disabled).toBe(true);
  expect(container.textContent).toContain("Unable to verify");
  expect(localStorage.getItem(METEORA_PENDING_KEY)).toBe("{bad");
});
it.each(["setup", "deposit"])("does not consume a new record when an old %s status response arrives", async kind => {
  await readyStage(kind);
  const original = fetch;
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const body = JSON.parse(args[1]!.body as string);
    if (body.action === "status") return new Promise<Response>(resolve => { release = resolve; });
    return original(...args);
  });
  send = async () => Response.json({ signature: expectedSignature }); await click(stageButton(kind));
  const replacement = { ...saved(), [`${kind}Signature`]: bs58.encode(new Uint8Array(64).fill(66)) };
  localStorage.setItem(key(), JSON.stringify(replacement));
  await act(async () => { release(Response.json({ signature: expectedSignature, status: "confirmed" })); await flush(); });
  expect(saved()).toEqual(replacement);
  if (kind === "setup") expect(actions).not.toContain("deposit");
});

it("clears a confirmed deposit only after matching status, without a record request", async () => {
  await readyStage("deposit");
  const original = fetch;
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    if (JSON.parse(args[1]!.body as string).action === "status") {
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return original(...args);
  });
  await click("Sign 2/2");
  expect(saved()).toMatchObject({ stage: "deposit_submitted", depositSignature: expectedSignature });
  expect(container.textContent).not.toContain("Liquidity added. Your position is open.");
  await act(async () => { release(Response.json({ signature: expectedSignature, status: "confirmed" })); await flush(); });
  expect(localStorage.getItem(key())).toBeNull();
  expect(container.textContent).toContain("Liquidity added. Your position is open.");
  expect(actions).not.toContain("record");
  expect(sends).toHaveLength(2);
});
it("revokes a retained setup callback after confirmation", async () => {
  const element = button("Sign 1/2");
  const prop = Object.keys(element).find(k => k.startsWith("__reactProps$"))!;
  const retained = (element as unknown as Record<string, { onClick: () => void }>)[prop]!.onClick;
  status = "confirmed"; send = async () => Response.json({ signature: expectedSignature });
  await click("Sign 1/2");
  await act(async () => { retained(); await flush(); });
  expect(sends).toHaveLength(1);
});

it("blocks broadcasting when storage silently discards the signature", async () => {
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {});
  await click("Sign 1/2");
  expect(sends).toHaveLength(0);
  expect(container.textContent).toContain("Unable to verify");
});
it("keeps unknown after polling expires, then rechecks only the original signature", async () => {
  send = async () => { throw new Error("lost"); };
  await click("Sign 1/2");
  const previous = localStorage.getItem(key()), signature = expectedSignature;
  await act(async () => { await vi.advanceTimersByTimeAsync(151_000); });
  expect(container.textContent).toContain("Not yet verified");
  expect(localStorage.getItem(key())).toBe(previous);
  expect(button("Prepare 1/2").disabled).toBe(true);
  expect(button("Check original transaction").disabled).toBe(false);
  status = "confirmed";
  await click("Check original transaction");
  expect(saved()).toMatchObject({ setupSignature: signature, stage: "setup_confirmed" });
  expect(sends).toHaveLength(1);
});
it("ignores unrelated terminal signatures returned by send and status", async () => {
  const original = fetch;
  const wrong = bs58.encode(new Uint8Array(64).fill(99));
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    if (JSON.parse(args[1]!.body as string).action === "status") return Response.json({ signature: wrong, status: "confirmed" });
    return original(...args);
  });
  send = async () => Response.json({ signature: wrong });
  await click("Sign 1/2");
  await act(async () => { await vi.advanceTimersByTimeAsync(151_000); });
  expect(saved()).toMatchObject({ setupSignature: expectedSignature, stage: "setup_submitted" });
  expect(actions).not.toContain("deposit");
});
it("does not apply delayed prepare to a different wallet", async () => {
  const original = fetch;
  let release!: () => void;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    if (JSON.parse(args[1]!.body as string).action === "setup") await new Promise<void>(r => { release = r; });
    return response;
  });
  await click("Prepare 1/2");
  connection = { ...connection, address: other.publicKey.toBase58() };
  await act(async () => render());
  await act(async () => { release(); await flush(); });
  expect(button("Sign 1/2").disabled).toBe(true);
  expect(button("Prepare 1/2").disabled).toBe(false);
  expect(sends).toHaveLength(0);
});
it("preserves the old wallet's record when a delayed send response arrives", async () => {
  let release!: (response: Response) => void;
  send = () => new Promise(r => { release = r; });
  await click("Sign 1/2");
  const previous = localStorage.getItem(key());
  connection = { ...connection, address: other.publicKey.toBase58() };
  await act(async () => render());
  await act(async () => { release(Response.json({ sent: false }, { status: 422 })); await flush(); });
  expect(localStorage.getItem(key())).toBe(previous);
  expect(button("Prepare 1/2").disabled).toBe(false);
});
it("does not prepare or sign a confirmed position for another pool", async () => {
  await readyStage("deposit");
  selectedView = { ...view, poolId: owner.publicKey.toBase58() };
  await act(async () => render());
  expect(button("Prepare 2/2").disabled).toBe(true);
  expect(button("Sign 2/2").disabled).toBe(true);
  expect(button("Prepare close and refund").disabled).toBe(true);
  expect(container.textContent).toContain(`Return to pool ${view.poolId}`);
  expect(saved().stage).toBe("setup_confirmed");
});
it("rejects a wallet-modified core message before persisting or broadcasting", async () => {
  connection = { ...connection, signTransaction: async tx => { tx.message.recentBlockhash = owner.publicKey.toBase58(); tx.sign([owner]); return tx; } };
  await act(async () => render());
  await click("Sign 1/2");
  expect(sends).toHaveLength(0);
  expect(localStorage.getItem(key())).toBeNull();
});
it("keeps an incomplete legacy submission blocked for manual investigation", async () => {
  send = async () => { throw new Error("lost"); }; await click("Sign 1/2");
  const legacy = { ...saved(), setupSignature: undefined, setupLastValidBlockHeight: undefined };
  await act(async () => root.render(null));
  localStorage.removeItem(key()); localStorage.setItem(METEORA_PENDING_KEY, JSON.stringify(legacy));
  await act(async () => render());
  await act(async () => { await flush(); });
  expect(container.textContent).toContain("older transaction record");
  expect(button("Prepare 1/2").disabled).toBe(true);
  expect(localStorage.getItem(METEORA_PENDING_KEY)).toBe(JSON.stringify(legacy));
  expect(sends).toHaveLength(1);
});
