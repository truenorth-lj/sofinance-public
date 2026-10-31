// @vitest-environment happy-dom
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { compoundAttemptKey } from "@sofinance/engine/compound-attempt";
import { POSITION_HISTORY_REFRESH_EVENT } from "@/lib/position-history-refresh";
import { CompoundPanel } from "./compound-panel";
import { useCompoundController, type CompoundConfirmation } from "./use-compound-controller";

const mocks = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({
  address: wallet, connected: !!wallet, signTransaction: mocks.sign,
}) }));
let wallet: string | undefined, mint: string | undefined;
let fixture: ReturnType<typeof compoundHistoryFixture>;
let controller: ReturnType<typeof useCompoundController>;
let root: Root, container: HTMLDivElement, mounted: boolean;
let onConfirmed: Mock<() => void>, notify: Mock<(event: Event) => void>;
let writes: ReturnType<typeof vi.spyOn>, removes: ReturnType<typeof vi.spyOn>;
type Call = { path: string; body: unknown; at: number };
let calls: Call[], views: unknown[];
let read: (body: { wallet: string; positionMint: string }) => Response | Promise<Response>;
let confirm: () => Response | Promise<Response>;
let prepare: () => Response;
let broadcast: () => Response;
let pending: Array<() => void>;
const stateCalls = () => calls.filter(c => c.path === "/api/compound-state");
const confirmCalls = () => calls.filter(c => c.path === "/api/compound-confirm");
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const failure = (message = "read failed", code?: string) => Response.json({ error: message, code }, { status: 503 });
const snapshot = (amount = "10", selectedWallet = wallet!, selectedMint = mint!) =>
  ({ ...fixture.state, wallet: selectedWallet, positionMint: selectedMint, fees: { a: amount, b: "0" } });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  pending.push(() => resolve(Response.json(fixture.state)));
  return { promise, resolve: async (response: Response) => { await act(async () => { resolve(response); }); } };
}
function Probe() {
  const value = useCompoundController({ wallet, positionMint: mint, externalBlocked: false, onConfirmed });
  useLayoutEffect(() => {
    controller = value;
    views.push({ at: Date.now(), wallet: value.wallet, mint: value.positionMint, state: value.state,
      loading: value.loading, error: value.error, preview: value.preview, canCompound: value.canCompound });
  });
  return createElement(CompoundPanel, { controller: value });
}
async function render(strict = false) {
  await act(async () => root.render(strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe)));
}
async function start(strict = false) { await render(strict); await advance(1); await advance(1); }
function seedAttempt() { window.localStorage.setItem(compoundAttemptKey(fixture.wallet), JSON.stringify(fixture.attempt)); }
function settled(state: CompoundConfirmation["state"]) {
  return Response.json({ signature: fixture.attempt.signature, status: "success", chainStatus: "success", state });
}
function noTransactions() {
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(calls.filter(c => /prepare|broadcast/.test(c.path))).toEqual([]);
  expect(writes).not.toHaveBeenCalled(); expect(removes).not.toHaveBeenCalled();
  expect(onConfirmed).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
}
function expectReadPayloads() {
  for (const call of stateCalls()) expect(call.body).toEqual({ wallet: expect.any(String), positionMint: expect.any(String) });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  fixture = compoundHistoryFixture(); wallet = fixture.wallet; mint = fixture.state.positionMint;
  calls = []; views = []; pending = []; mounted = true;
  onConfirmed = vi.fn(); notify = vi.fn(); mocks.sign.mockReset();
  window.addEventListener(POSITION_HISTORY_REFRESH_EVENT, notify);
  writes = vi.spyOn(window.localStorage, "setItem"); removes = vi.spyOn(window.localStorage, "removeItem");
  read = body => Response.json(snapshot("10", body.wallet, body.positionMint));
  confirm = () => Response.json({ signature: fixture.attempt.signature, status: "pending", state: null });
  prepare = () => failure("prepare failed", "rpc_unavailable");
  broadcast = () => Response.json({ error: "broadcast unsent", sent: false, code: "rpc_unavailable" }, { status: 503 });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, at: Date.now() });
    if (path === "/api/sol-usdc-price") return Response.json({ rate: 150, usdcUsd: 1 });
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store" });
    if (path === "/api/compound-state") return read(body);
    if (path === "/api/compound-confirm") return confirm();
    if (path === "/api/compound-prepare") return prepare();
    if (path === "/api/tx-send") return broadcast();
    throw new Error(`Unexpected request ${path}`);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async context => {
  expectReadPayloads();
  if (mounted) await act(async () => root.unmount());
  const count = stateCalls().length;
  await act(async () => { for (const finish of pending) finish(); });
  // Baseline keeps read backoff timers until they wake; wake guards must prevent a new request.
  await advance(10_000);
  expect(stateCalls()).toHaveLength(count);
  // eslint-disable-next-line no-console -- Raw preservation ledger for independent before/after comparison.
  console.log("SNAPSHOT_LEDGER " + JSON.stringify({ test: context.task.name, calls, views,
    sign: mocks.sign.mock.calls.length, notify: notify.mock.calls.length, confirmed: onConfirmed.mock.calls.length,
    writes: writes.mock.calls, removes: removes.mock.calls }));
  window.removeEventListener(POSITION_HISTORY_REFRESH_EVENT, notify);
  container.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("compound snapshot preservation through the real controller and panel", () => {
  it.each(["success", "error"])("R2 wins over deferred R1 %s and a later read still succeeds", async result => {
    const first = deferred(); const second = deferred();
    read = () => first.promise; await start();
    expect(controller.loading).toBe(true); expect(controller.state).toBeNull();
    read = () => second.promise; await act(async () => { void controller.refreshState(); });
    await first.resolve(result === "success" ? Response.json(snapshot("1")) : failure("stale"));
    expect(controller.loading).toBe(true); expect(controller.error).toBe(""); expect(controller.state).toBeNull();
    await second.resolve(Response.json(snapshot("2")));
    expect(controller.state?.fees.a).toBe("2"); expect(controller.loading).toBe(false);
    read = () => Response.json(snapshot("3")); await act(async () => { await controller.refreshState(); });
    expect(controller.state?.fees.a).toBe("3"); expect(controller.error).toBe("");
    expect(stateCalls().map(c => c.body)).toEqual(Array(3).fill({ wallet, positionMint: mint })); noTransactions();
  });

  it.each(["success", "error"])("ignores a late old read %s after R2 has already settled", async result => {
    const first = deferred(); read = () => first.promise; await start();
    read = () => Response.json(snapshot("2")); await act(async () => { await controller.refreshState(); });
    await first.resolve(result === "success" ? Response.json(snapshot("1")) : failure("stale"));
    expect(controller.state?.fees.a).toBe("2"); expect(controller.loading).toBe(false); noTransactions();
  });

  it.each(["wallet", "positionMint"])("rejects wrong %s reply, retains snapshot, and accepts the next correct read", async field => {
    await start(); read = () => Response.json({ ...snapshot("99"), [field]: testKeypair(90).publicKey.toBase58() });
    await act(async () => { await controller.refreshState(); });
    expect(controller.state?.fees.a).toBe("10"); expect(controller.error).toBe("Yield reading does not match selected position");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(controller.error);
    read = () => Response.json(snapshot("20")); await act(async () => { await controller.refreshState(); });
    expect(controller.state?.fees.a).toBe("20"); expect(controller.error).toBe(""); noTransactions();
  });

  it.each(["wallet", "mint"])("committed %s A/B/ABA invalidates old requests before the reset timer", async field => {
    const old = deferred(); read = () => old.promise; await start();
    const originalWallet = wallet, originalMint = mint;
    if (field === "wallet") wallet = testKeypair(90).publicKey.toBase58(); else mint = testKeypair(91).publicKey.toBase58();
    const next = deferred(); read = () => next.promise; await render();
    expect(controller.state).toBeNull(); expect(controller.loading).toBe(true);
    await advance(1); await next.resolve(Response.json(snapshot("22")));
    expect(controller.state?.fees.a).toBe("22");
    wallet = originalWallet; mint = originalMint;
    const last = deferred(); read = () => last.promise; await render();
    await old.resolve(Response.json(snapshot("99")));
    expect(controller.state).toBeNull(); expect(controller.error).toBe("");
    await advance(1); await last.resolve(Response.json(snapshot("33")));
    expect(controller.state?.fees.a).toBe("33"); expect(controller.loading).toBe(false);
    expect(stateCalls()).toHaveLength(3); noTransactions();
  });

  it("same-NFT confirmation adopts synchronously and invalidates a late read without fetching twice", async () => {
    seedAttempt(); const old = deferred(), status = deferred();
    read = () => old.promise; confirm = () => status.promise; await start();
    expect(confirmCalls()).toHaveLength(1); expect(confirmCalls()[0]!.body).toEqual({ wallet, attempt: fixture.attempt });
    await status.resolve(settled(snapshot("50")));
    expect(controller.state?.fees.a).toBe("50"); expect(controller.loading).toBe(false);
    expect(stateCalls()).toHaveLength(1); expect(onConfirmed).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
    await old.resolve(Response.json(snapshot("1"))); expect(controller.state?.fees.a).toBe("50");
    read = () => Response.json(snapshot("51")); await act(async () => { await controller.refreshState(); });
    expect(controller.state?.fees.a).toBe("51"); expect(stateCalls()).toHaveLength(2);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("other-NFT confirmation refreshes the selected NFT once and callback churn does not restart polling", async () => {
    seedAttempt(); await start(); const initialRefresh = controller.refreshState;
    mint = testKeypair(92).publicKey.toBase58(); await start();
    const currentRefresh = controller.refreshState; expect(currentRefresh).not.toBe(initialRefresh);
    const oldCallback = onConfirmed; onConfirmed = vi.fn(); await render(); await advance(1);
    expect(controller.refreshState).toBe(currentRefresh); expect(stateCalls()).toHaveLength(2); expect(confirmCalls()).toHaveLength(1);
    confirm = () => settled(fixture.state); await advance(4_000);
    expect(confirmCalls()).toHaveLength(2); expect(stateCalls()).toHaveLength(3);
    expect(stateCalls()[2]!.body).toEqual({ wallet, positionMint: mint });
    expect(controller.state?.positionMint).toBe(mint); expect(oldCallback).not.toHaveBeenCalled();
    expect(onConfirmed).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
    await advance(8_000); expect(confirmCalls()).toHaveLength(2); expect(stateCalls()).toHaveLength(3);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("StrictMode replay and callback rerenders keep one initial yield read and a working reload button", async () => {
    await start(true); const refresh = controller.refreshState;
    for (let i = 0; i < 3; i++) { onConfirmed = vi.fn(); await render(true); await advance(1); }
    expect(stateCalls()).toHaveLength(1); expect(controller.refreshState).toBe(refresh);
    read = () => Response.json(snapshot("66"));
    const reload = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Reload yield"))!;
    expect(reload.disabled).toBe(false); await act(async () => reload.click());
    expect(controller.state?.fees.a).toBe("66"); expect(stateCalls()).toHaveLength(2); noTransactions();
  });

  it.each(["deferred", "backoff"])("unmount during %s sends no further read; a fresh mount remains live", async mode => {
    const old = deferred(); read = () => mode === "backoff" ? failure("rpc", "rpc_unavailable") : old.promise;
    await start(); await act(async () => root.unmount()); mounted = false;
    await old.resolve(Response.json(snapshot("99"))); await advance(5_000);
    expect(stateCalls()).toHaveLength(1);
    root = createRoot(container); mounted = true; read = () => Response.json(snapshot("70")); await start();
    expect(controller.state?.fees.a).toBe("70"); expect(controller.loading).toBe(false); expect(stateCalls()).toHaveLength(2); noTransactions();
  });

  it.each(["wallet", "mint"])("invalid %s clears state/loading without another HTTP call, then valid input recovers", async field => {
    await start(); read = () => failure("retain this error"); await act(async () => { await controller.refreshState(); });
    expect(controller.state?.fees.a).toBe("10");
    const old = deferred(); read = () => old.promise; await act(async () => { void controller.refreshState(); });
    const oldWallet = wallet, oldMint = mint;
    if (field === "wallet") wallet = undefined; else mint = undefined;
    await render(); expect(controller.state).toBeNull(); expect(controller.loading).toBe(true);
    await advance(1); expect(controller.loading).toBe(false); expect(stateCalls()).toHaveLength(3);
    await old.resolve(Response.json(snapshot("99", oldWallet, oldMint))); expect(controller.state).toBeNull();
    wallet = oldWallet; mint = oldMint; read = () => Response.json(snapshot("80")); await start();
    expect(controller.state?.fees.a).toBe("80"); expect(controller.error).toBe(""); noTransactions();
  });

  it("only retries rpc_unavailable at exactly 1500/3000ms, preserves prior state and recovers after exhaustion", async () => {
    await start(); const began = Date.now(); read = () => failure("rpc", "rpc_unavailable");
    await act(async () => { void controller.refreshState(); });
    expect(controller.loading).toBe(true); expect(controller.state?.fees.a).toBe("10");
    await advance(1499); expect(stateCalls()).toHaveLength(2);
    await advance(1); expect(stateCalls()).toHaveLength(3);
    await advance(2999); expect(stateCalls()).toHaveLength(3);
    await advance(1); expect(stateCalls()).toHaveLength(4);
    expect(stateCalls().slice(1).map(c => c.at - began)).toEqual([0, 1500, 4500]);
    expect(controller.error).toBe("rpc"); expect(controller.state?.fees.a).toBe("10"); expect(controller.loading).toBe(false);
    await advance(10_000); expect(stateCalls()).toHaveLength(4);
    read = () => Response.json(snapshot("90")); await act(async () => { await controller.refreshState(); });
    expect(controller.error).toBe(""); expect(controller.state?.fees.a).toBe("90"); noTransactions();
  });

  it.each(["prepare", "broadcast"])("read success/error cannot clear or replace %s failure and never retries that command", async phase => {
    if (phase === "broadcast") {
      prepare = () => {
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: testKeypair(1).publicKey,
          recentBlockhash: fixture.attempt.summary.blockhash, instructions: [] }).compileToV0Message());
        return Response.json({ summary: fixture.attempt.summary, permit: "synthetic", unsignedTransaction: Buffer.from(tx.serialize()).toString("base64") });
      };
      mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; });
    }
    await start(); await act(async () => controller.compound());
    const error = phase === "prepare" ? "prepare failed" : "broadcast unsent. Nothing was sent.";
    expect(controller.error).toBe(error);
    read = () => Response.json(snapshot("100")); await act(async () => { await controller.refreshState(); });
    expect(controller.state?.fees.a).toBe("100"); expect(controller.error).toBe(error);
    read = () => failure("new read error"); await act(async () => { await controller.refreshState(); });
    expect(controller.state?.fees.a).toBe("100"); expect(controller.error).toBe(error); expect(controller.loading).toBe(false);
    await advance(5_000);
    expect(calls.filter(c => c.path === "/api/compound-prepare")).toHaveLength(1);
    expect(calls.filter(c => c.path === "/api/tx-send")).toHaveLength(phase === "broadcast" ? 1 : 0);
    expect(mocks.sign).toHaveBeenCalledTimes(phase === "broadcast" ? 1 : 0);
    expect(onConfirmed).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
});
