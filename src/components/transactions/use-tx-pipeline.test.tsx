// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn(), captureTxWalletErrorLanded: vi.fn() }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));

import { VersionedTransaction } from "@solana/web3.js";
import { WALLET_MUST_SEND } from "@/lib/tx-pipeline/wallet-send";
import { CANCEL_CHECK_PENDING_COPY, resetCancelChecks, dismissTxNotice, findTxNotice, getTxNotices, noticeIdFor, resetTxNotices, settleTxNotice, TxNotSentError, type TxAdapter, type TxWallet } from "@/lib/tx-pipeline";
import { TxNoticeHost } from "./tx-notice-host";
import { openStatusFromNotice } from "@/components/use-open-attempt";
import { useTxPipeline } from "./use-tx-pipeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const payer = testKeypair(41);
const SIG = bs58.encode(new Uint8Array(64).fill(4));
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const wallet = (address = payer.publicKey.toBase58(), send = vi.fn(async () => SIG)): TxWallet => ({ address, signTransaction: vi.fn(), signAndSendTransaction: send });

let root: Root; let container: HTMLElement; const box = {} as { current: ReturnType<typeof useTxPipeline<number, never>> };
function Harness(props: { adapter: TxAdapter<number>; wallet: TxWallet | null; scope?: string }) {
  const value = useTxPipeline(props.adapter as never, props.wallet, { scope: props.scope }) as never;
  useLayoutEffect(() => { box.current = value; });
  return null;
}
const render = async (adapter: TxAdapter<number>, w: TxWallet | null, scope?: string) =>
  act(async () => root.render(createElement(Harness, { adapter, wallet: w, scope })));
/** Input n is "position pos-n". */
const adapter = (prepare: TxAdapter<number>["prepare"]): TxAdapter<number> =>
  ({ flow: "add", successTitle: "Liquidity added", prepare, scope: (n) => `pos-${n}` });
const prepared = () => ({ transaction: buildTransaction({ payer, signWith: [] }), lastValidBlockHeight: 1 });

beforeEach(() => { resetTxNotices(); resetCancelChecks(); window.localStorage.clear(); container = document.createElement("div"); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); });

describe("useTxPipeline", () => {
  // The toast is not the source of truth: the dialog must keep the result after the toast closes.
  describe("keeps the settled result after its toast closes", () => {
    const withHost = async (a: TxAdapter<number>, w: TxWallet) => act(async () => root.render(createElement("div", null,
      createElement(Harness, { adapter: a, wallet: w }), createElement(TxNoticeHost, { wallet: w.address }))));
    beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "pending" }))); });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it("keeps the success toast until dismissed, and still shows success after the user closes it", async () => {
      await withHost(adapter(async () => prepared()), wallet());
      await act(async () => { await box.current.run(1); });
      expect(box.current.status).toBe("confirming");
      await act(async () => { settleTxNotice(noticeIdFor(SIG), "confirmed"); });
      expect(box.current).toMatchObject({ status: "success", kind: "landed", signature: SIG });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(findTxNotice(noticeIdFor(SIG))?.state).toBe("success");
      await act(async () => { dismissTxNotice(noticeIdFor(SIG)); });
      expect(findTxNotice(noticeIdFor(SIG))).toBeUndefined();
      expect(box.current).toMatchObject({ status: "success", kind: "landed", signature: SIG });
    });

    it("still shows expired with Try again after the user dismisses the expiry toast", async () => {
      const prepare = vi.fn(async () => prepared());
      await withHost(adapter(prepare), wallet());
      await act(async () => { await box.current.run(3); });
      await act(async () => { settleTxNotice(noticeIdFor(SIG), "expired"); });
      expect(box.current).toMatchObject({ status: "failed", kind: "expired", retryable: true, signature: SIG });
      await act(async () => { dismissTxNotice(noticeIdFor(SIG)); });
      expect(findTxNotice(noticeIdFor(SIG))).toBeUndefined();
      expect(box.current).toMatchObject({ status: "failed", kind: "expired", retryable: true, signature: SIG });
      await act(async () => { box.current.retry(); });
      await act(async () => {});
      expect(prepare).toHaveBeenCalledTimes(2); expect(prepare).toHaveBeenLastCalledWith(3, expect.anything());
    });
  });

  it("locks closing while preparing and signing, then follows the shared notice to success", async () => {
    const prep = deferred<ReturnType<typeof prepared>>();
    const send = deferred<string>();
    const w = wallet(undefined, vi.fn(() => send.promise));
    await render(adapter(() => prep.promise), w);
    let run!: Promise<unknown>;
    await act(async () => { run = box.current.run(1); });
    expect(box.current).toMatchObject({ status: "preparing", closeLocked: true, busy: true });
    await act(async () => { prep.resolve(prepared()); });
    expect(box.current).toMatchObject({ status: "wallet", closeLocked: true });
    await act(async () => { send.resolve(SIG); await run; });
    expect(box.current).toMatchObject({ status: "confirming", signature: SIG, closeLocked: false });
    await act(async () => { settleTxNotice(noticeIdFor(SIG), "confirmed"); });
    expect(box.current).toMatchObject({ status: "success", kind: "landed", signature: SIG });
  });
  it("shows a plain error with a one-tap retry that re-runs the same input", async () => {
    const prepare = vi.fn().mockRejectedValueOnce(new TxNotSentError("Pool is paused")).mockResolvedValueOnce(prepared());
    await render(adapter(prepare), wallet());
    await act(async () => { await box.current.run(7); });
    expect(box.current).toMatchObject({ status: "failed", error: "Pool is paused. Nothing was sent.", kind: "not-sent", retryable: true });
    await act(async () => { box.current.retry(); });
    await act(async () => {});
    expect(prepare).toHaveBeenLastCalledWith(7, expect.anything());
    expect(box.current.status).toBe("confirming");
  });
  it("returns to idle on a wallet rejection while signing (nothing was broadcast)", async () => {
    const w: TxWallet = { address: payer.publicKey.toBase58(), signTransaction: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }) };
    await render(adapter(async () => prepared()), w);
    await act(async () => { await box.current.run(1); });
    expect(box.current.status).toBe("idle"); expect(getTxNotices()).toEqual([]);
  });
  it("locks submit (and re-quote) while checking Solana after a wallet error and while confirming", async () => {
    // The real lookup client (waitForLanded → /api/tx-landed), held open until the test answers.
    const lookup = deferred<Response>();
    const fetchMock = vi.fn((url: string) => url === "/api/tx-landed" ? lookup.promise : Promise.resolve(Response.json({ status: "pending" })));
    vi.stubGlobal("fetch", fetchMock);
    const prepare = vi.fn(async () => ({ ...prepared(), sendPermit: "permit", landedPermit: "check" }));
    const w = wallet(undefined, vi.fn(async () => { throw new Error('{"code":400,"message":"Request ab12cd34ef rejected by user"}'); }));
    await render(adapter(prepare), w);
    let first!: Promise<unknown>;
    await act(async () => { first = box.current.run(1); });
    expect(box.current).toMatchObject({ status: "checking", busy: true, locked: true, closeLocked: false });
    await act(async () => { await box.current.run(2); box.current.retry(); });
    expect(prepare).toHaveBeenCalledTimes(1); expect(w.signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/tx-landed", expect.objectContaining({ method: "POST" }));
    await act(async () => { lookup.resolve(Response.json({ status: "landed", signature: SIG })); await first; });
    expect(box.current).toMatchObject({ status: "confirming", signature: SIG, busy: false, locked: true });
    await act(async () => { await box.current.run(3); });
    expect(prepare).toHaveBeenCalledTimes(1);
    await act(async () => { settleTxNotice(noticeIdFor(SIG), "confirmed"); });
    expect(box.current).toMatchObject({ status: "success", locked: false });
    vi.unstubAllGlobals();
  });
  it("4001 after a sign-and-send request: 'checking' for up to 20 s, then cancelled; the same position waits for the background check, another position does not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const lookup = deferred<Response>();
    const fetchMock = vi.fn((url: string) => url === "/api/tx-landed" ? lookup.promise : Promise.resolve(Response.json({ status: "pending" })));
    vi.stubGlobal("fetch", fetchMock);
    const prepare = vi.fn(async () => ({ ...prepared(), sendPermit: "permit", landedPermit: "check" }));
    const send = vi.fn(async (): Promise<string> => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); });
    const w = wallet(undefined, send);
    await render(adapter(prepare), w, "pos-1");
    let first!: Promise<unknown>;
    await act(async () => { first = box.current.run(1); await vi.advanceTimersByTimeAsync(10); });
    // Checking first: locked, never "failed" or "cancelled" yet.
    expect(box.current).toMatchObject({ status: "checking", locked: true });
    expect(getTxNotices()).toMatchObject([{ state: "loading", title: "Checking Solana…" }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); await first; });
    vi.useRealTimers();
    // Window over, nothing seen yet: idle, not busy, and the cancel toast is up while the lookup is still pending.
    expect(box.current).toMatchObject({ status: "idle", busy: false, locked: false, cancelPending: true });
    expect(getTxNotices()).toMatchObject([{ state: "failure", kind: "rejected", title: "Add liquidity cancelled",
      detail: "You cancelled in your wallet. We are still checking Solana in case it went through; you can retry in about a minute." }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/tx-landed", expect.objectContaining({ method: "POST" }));
    expect(CANCEL_CHECK_PENDING_COPY).toBe("Cancelled — you can retry in about a minute");
    // Same position: refused before preparing (the form shows the copy and keeps its button disabled).
    await act(async () => { await box.current.run(1); });
    expect(prepare).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    expect(box.current).toMatchObject({ status: "idle", cancelPending: true });
    // Another position of the same flow is not held.
    const SECOND = bs58.encode(new Uint8Array(64).fill(6));
    send.mockImplementationOnce(async () => SECOND);
    await act(async () => { await box.current.run(2); });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(box.current).toMatchObject({ status: "confirming", signature: SECOND, locked: true });
    // The first attempt turns out to have landed: tracked on its own, the other position's state is untouched.
    await act(async () => { lookup.resolve(Response.json({ status: "landed", signature: SIG })); await new Promise((r) => setTimeout(r, 0)); });
    expect(findTxNotice(noticeIdFor(SIG))).toMatchObject({ state: "loading", signature: SIG });
    expect(getTxNotices().some((n) => n.kind === "rejected")).toBe(false);
    expect(box.current).toMatchObject({ status: "confirming", signature: SECOND, cancelPending: false });
    await act(async () => { settleTxNotice(noticeIdFor(SIG), "confirmed"); });
    expect(findTxNotice(noticeIdFor(SIG))).toMatchObject({ state: "success" });
    expect(box.current).toMatchObject({ status: "confirming", signature: SECOND, locked: true });
    await act(async () => { settleTxNotice(noticeIdFor(SECOND), "confirmed"); });
    expect(box.current).toMatchObject({ status: "success", signature: SECOND, locked: false });
    vi.unstubAllGlobals();
  });
  it("ignores a second run while busy", async () => {
    const prep = deferred<ReturnType<typeof prepared>>(); const prepare = vi.fn(() => prep.promise);
    await render(adapter(prepare), wallet());
    await act(async () => { void box.current.run(1); void box.current.run(2); });
    expect(prepare).toHaveBeenCalledTimes(1);
    await act(async () => { prep.resolve(prepared()); });
  });
  it("never asks the wallet after a wallet switch during prepare", async () => {
    const prep = deferred<ReturnType<typeof prepared>>(); const first = wallet();
    await render(adapter(() => prep.promise), first);
    await act(async () => { void box.current.run(1); });
    await render(adapter(() => prep.promise), wallet(testKeypair(42).publicKey.toBase58()));
    expect(box.current.status).toBe("idle");
    await act(async () => { prep.resolve(prepared()); });
    expect(first.signAndSendTransaction).not.toHaveBeenCalled();
  });
  it("detaches its retry from toasts on unmount", async () => {
    await render(adapter(async () => { throw new TxNotSentError("nope"); }), wallet());
    await act(async () => { await box.current.run(1); });
    expect(getTxNotices()[0]?.retry).toBeTypeOf("function");
    await act(async () => root.unmount()); root = createRoot(container);
    expect(getTxNotices()[0]?.retry).toBeUndefined();
  });
});

describe("useTxPipeline runSteps (multi-step plans)", () => {
  // Two-step plan shaped like a DEX open: step 1 creates an account, step 2 needs it confirmed (planToken + prior sigs).
  type Step = { step: number; planToken?: string; prior: string[] };
  type StepPrepared = ReturnType<typeof prepared> & { result: { step: number; of: number; done: boolean; planToken?: string } };
  const SIG2 = bs58.encode(new Uint8Array(64).fill(7));
  const stepAdapter = (prepare: (input: Step) => Promise<StepPrepared>) =>
    ({ flow: "open", successTitle: "Position step confirmed", prepare, scope: (input: Step) => `pool:${input.step}` }) as unknown as TxAdapter<number>;
  const stepPrepared = (step: number): StepPrepared => ({ ...prepared(), result: { step, of: 2, done: step === 2, ...(step === 1 ? { planToken: "position-1" } : {}) } });
  const plan = {
    progress: (p: StepPrepared) => ({ step: p.result.step, of: p.result.of }),
    next: (sent: { signature: string; prepared: StepPrepared }, earlier: readonly { signature: string }[]): Step | null =>
      sent.prepared.result.done ? null : { step: sent.prepared.result.step + 1, planToken: sent.prepared.result.planToken, prior: [...earlier, sent].map((s) => s.signature) },
  };
  type StepsBox = { runSteps: (first: Step, p: typeof plan) => Promise<unknown>; retry: () => void; status: string; error?: string; signature?: string; retryable?: boolean; step?: unknown; locked: boolean };
  const steps = () => box.current as unknown as StepsBox;
  /** /api/transaction-finality answers for step 1's signature; anything else stays pending. */
  const finality = (status: string) => vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { signature?: string };
    return Response.json({ status: url === "/api/transaction-finality" && body.signature === SIG ? status : "pending" });
  });
  const twoSends = () => wallet(undefined, vi.fn<() => Promise<string>>().mockResolvedValueOnce(SIG).mockResolvedValueOnce(SIG2));
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("prepares step 2 only after step 1 is confirmed, with its planToken and signature, and succeeds only when step 2 confirms", async () => {
    const confirm = deferred<Response>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { signature?: string };
      return body.signature === SIG ? confirm.promise : Response.json({ status: "pending" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const prepare = vi.fn(async (input: Step) => stepPrepared(input.step));
    await render(stepAdapter(prepare), twoSends());
    let running!: Promise<unknown>;
    await act(async () => { running = steps().runSteps({ step: 1, prior: [] }, plan); });
    // Step 1 sent and confirming: step 2 is not prepared yet, the run stays busy, and nothing says success.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(steps()).toMatchObject({ status: "confirming", signature: SIG, locked: true, step: { step: 1, of: 2 } });
    await act(async () => { settleTxNotice(noticeIdFor(SIG), "confirmed"); });
    expect(steps().status).toBe("confirming"); // step 1's own toast settling is not the run's success
    await act(async () => { confirm.resolve(Response.json({ status: "confirmed" })); await running; });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenLastCalledWith({ step: 2, planToken: "position-1", prior: [SIG] }, expect.anything());
    expect(steps()).toMatchObject({ status: "confirming", signature: SIG2, step: { step: 2, of: 2 } });
    await act(async () => { settleTxNotice(noticeIdFor(SIG2), "confirmed"); });
    expect(steps()).toMatchObject({ status: "success", signature: SIG2, locked: false });
  });

  it("step 2 refused: says step 1 is on Solana and why step 2 stopped, never success; Try again resumes step 2 only", async () => {
    vi.stubGlobal("fetch", finality("confirmed"));
    const prepare = vi.fn(async (input: Step) => {
      if (input.step === 2 && prepare.mock.calls.length === 2) throw new TxNotSentError("Jupiter has no route right now");
      return stepPrepared(input.step);
    });
    await render(stepAdapter(prepare), twoSends());
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(steps()).toMatchObject({ status: "failed", retryable: true, step: { step: 2, of: 2 },
      error: "Step 1 of 2 is confirmed on Solana, but step 2 of 2 did not go through: Jupiter has no route right now. Nothing was sent." });
    await act(async () => { steps().retry(); });
    await act(async () => {});
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare.mock.calls.map(([input]) => input.step)).toEqual([1, 2, 2]);
    expect(prepare).toHaveBeenLastCalledWith({ step: 2, planToken: "position-1", prior: [SIG] }, expect.anything());
    expect(steps()).toMatchObject({ status: "confirming", signature: SIG2 });
  });

  it("step 2 cancelled in the wallet after step 1 landed: a failure that says so, not a silent idle", async () => {
    vi.stubGlobal("fetch", finality("confirmed"));
    const send = vi.fn<() => Promise<string>>().mockResolvedValueOnce(SIG)
      .mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const w: TxWallet = { address: payer.publicKey.toBase58(), signTransaction: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }), signAndSendTransaction: send };
    await render(stepAdapter(async (input) => stepPrepared(input.step)), w);
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(steps().status).toBe("failed");
    expect(steps().error).toMatch(/^Step 1 of 2 is confirmed on Solana, but step 2 of 2 did not go through: /);
  });

  it("step 1 not confirmed: step 2 is never prepared and the run stops with 'still unconfirmed' (no Try again)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", finality("pending"));
    const prepare = vi.fn(async (input: Step) => stepPrepared(input.step));
    await render(stepAdapter(prepare), twoSends());
    let running!: Promise<unknown>;
    await act(async () => { running = steps().runSteps({ step: 1, prior: [] }, plan); await vi.advanceTimersByTimeAsync(10); });
    expect(steps()).toMatchObject({ status: "confirming", signature: SIG, locked: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(200_000); await running; });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(steps()).toMatchObject({ status: "failed", signature: SIG, retryable: false,
      error: "Step 1 of 2 is still unconfirmed, so step 2 of 2 was not started. Check it on Solscan before trying again; it may still land." });
  });

  it("step 1 failed on Solana: step 2 is never prepared, the failure is plain, and Try again restarts from step 1", async () => {
    vi.stubGlobal("fetch", finality("failed"));
    const prepare = vi.fn(async (input: Step) => stepPrepared(input.step));
    await render(stepAdapter(prepare), twoSends());
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(steps()).toMatchObject({ status: "failed", signature: SIG, retryable: true,
      error: "Step 1 of 2 failed on Solana, so step 2 of 2 was not started. Nothing changed except the network fee." });
    await act(async () => { steps().retry(); });
    await act(async () => {});
    expect(prepare.mock.calls.map(([input]) => input.step)).toEqual([1, 1]);
  });

  it("step 2 lands but fails on-chain: the failure names step 1 as confirmed", async () => {
    vi.stubGlobal("fetch", finality("confirmed"));
    await render(stepAdapter(async (input) => stepPrepared(input.step)), twoSends());
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    await act(async () => { settleTxNotice(noticeIdFor(SIG2), "failed"); });
    expect(steps()).toMatchObject({ status: "failed", signature: SIG2, retryable: true });
    expect(steps().error).toMatch(/^Step 1 of 2 is confirmed on Solana, but step 2 of 2 did not go through: Solana ran it/);
  });
});

describe("useTxPipeline runSteps: wallet-sent steps (DEX route: walletSends, cosigner presigns)", () => {
  type Step = { step: number; planToken?: string; prior: string[] };
  type StepPrepared = ReturnType<typeof prepared> & { walletSends: true; presign?: (tx: VersionedTransaction) => VersionedTransaction; landedPermit?: string;
    result: { step: number; of: number; done: boolean; planToken?: string } };
  const cosigner = testKeypair(42);
  const SIG2 = bs58.encode(new Uint8Array(64).fill(7));
  const stepAdapter = (prepare: (input: Step) => Promise<StepPrepared>) =>
    ({ flow: "open", successTitle: "Position step confirmed", prepare, scope: (input: Step) => `pool:${input.step}` }) as unknown as TxAdapter<number>;
  /** Step 1 carries the position cosigner (signs before the wallet); step 2 is wallet-only. Both: only the wallet sends. */
  const walletStep = (step: number, extra: Partial<StepPrepared> = {}): StepPrepared => ({
    transaction: buildTransaction({ payer, extraSigners: step === 1 ? [cosigner] : [], signWith: [] }), lastValidBlockHeight: 1, walletSends: true,
    ...(step === 1 ? { presign: (tx: VersionedTransaction) => { tx.sign([cosigner]); return tx; } } : {}),
    result: { step, of: 2, done: step === 2, ...(step === 1 ? { planToken: "position-1" } : {}) }, ...extra,
  });
  const plan = {
    progress: (p: StepPrepared) => ({ step: p.result.step, of: p.result.of }),
    next: (sent: { signature: string; prepared: StepPrepared }, earlier: readonly { signature: string }[]): Step | null =>
      sent.prepared.result.done ? null : { step: sent.prepared.result.step + 1, planToken: sent.prepared.result.planToken, prior: [...earlier, sent].map((s) => s.signature) },
  };
  type StepsBox = { runSteps: (first: Step, p: typeof plan) => Promise<unknown>; status: string; error?: string; signature?: string; retryable?: boolean; locked: boolean };
  const steps = () => box.current as unknown as StepsBox;
  /** Finality answers `status` for step 1's signature, the landed lookup answers `landed`; logs every URL. */
  const network = (status: string, landed?: () => Promise<Response>) => vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { signature?: string };
    if (url === "/api/tx-landed") return landed ? landed() : Response.json({ status: "unknown" });
    return Response.json({ status: url === "/api/transaction-finality" && body.signature === SIG ? status : "pending" });
  });
  const urls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url]) => url);
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("happy path: the wallet signs and sends both steps itself (cosigner presigned), never relayed; step 2 after step 1 confirms", async () => {
    const fetchMock = network("confirmed");
    vi.stubGlobal("fetch", fetchMock);
    const sentTxs: VersionedTransaction[] = [];
    const send = vi.fn(async (tx: VersionedTransaction) => { sentTxs.push(tx); return sentTxs.length === 1 ? SIG : SIG2; });
    const w = wallet(undefined, send as never);
    const prepare = vi.fn(async (input: Step) => walletStep(input.step));
    await render(stepAdapter(prepare), w);
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(prepare.mock.calls.map(([input]) => input)).toEqual([{ step: 1, prior: [] }, { step: 2, planToken: "position-1", prior: [SIG] }]);
    // Step 1 reached the wallet with the cosigner's signature already on it and the wallet's slot empty.
    expect(sentTxs[0]!.signatures[0]!.every((byte) => byte === 0)).toBe(true);
    expect(sentTxs[0]!.signatures[1]!.some((byte) => byte !== 0)).toBe(true);
    expect(w.signTransaction).not.toHaveBeenCalled();
    expect(urls(fetchMock)).not.toContain("/api/tx-send");
    expect(steps()).toMatchObject({ status: "confirming", signature: SIG2 });
    await act(async () => { settleTxNotice(noticeIdFor(SIG2), "confirmed"); });
    expect(steps()).toMatchObject({ status: "success", signature: SIG2, locked: false });
  });

  it("wallet cancels step 1 (4001): checks Solana first; not landed → 'did not go through, safe to retry', step 2 never prepared, nothing relayed", async () => {
    const fetchMock = network("confirmed", async () => Response.json({ status: "not-landed" }));
    vi.stubGlobal("fetch", fetchMock);
    const w = wallet(undefined, vi.fn(async (): Promise<string> => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }));
    const prepare = vi.fn(async (input: Step) => walletStep(input.step, { landedPermit: "check" }));
    await render(stepAdapter(prepare), w);
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(urls(fetchMock)).toContain("/api/tx-landed"); // the 4001 hotfix: never trust a wallet error before looking on-chain
    expect(urls(fetchMock)).not.toContain("/api/tx-send");
    expect(w.signTransaction).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(steps()).toMatchObject({ status: "failed", retryable: true,
      error: "You cancelled in your wallet. We checked Solana and it did not go through. Nothing was sent, safe to retry." });
  });

  it("wallet cancels step 1 (4001) but it had landed: treated as sent, and step 2 waits for its confirmation", async () => {
    const fetchMock = network("confirmed", async () => Response.json({ status: "landed", signature: SIG }));
    vi.stubGlobal("fetch", fetchMock);
    const send = vi.fn<(tx: VersionedTransaction) => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 })).mockResolvedValueOnce(SIG2);
    const prepare = vi.fn(async (input: Step) => walletStep(input.step, { landedPermit: "check" }));
    await render(stepAdapter(prepare), wallet(undefined, send as never));
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(prepare).toHaveBeenLastCalledWith({ step: 2, planToken: "position-1", prior: [SIG] }, expect.anything());
    expect(steps()).toMatchObject({ status: "confirming", signature: SIG2 });
  });

  it("send failure on step 1: a plain failure, step 2 never prepared, no relay fallback", async () => {
    const fetchMock = network("confirmed");
    vi.stubGlobal("fetch", fetchMock);
    const w = wallet(undefined, vi.fn(async (): Promise<string> => { throw new Error("Transaction simulation failed: insufficient lamports"); }));
    const prepare = vi.fn(async (input: Step) => walletStep(input.step));
    await render(stepAdapter(prepare), w);
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(steps().status).toBe("failed");
    expect(steps().error).not.toMatch(/success|confirmed/i);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(w.signTransaction).not.toHaveBeenCalled();
    expect(urls(fetchMock)).not.toContain("/api/tx-send");
  });

  it("a wallet that cannot send itself is refused before any prompt: nothing signed, nothing relayed", async () => {
    const fetchMock = network("confirmed");
    vi.stubGlobal("fetch", fetchMock);
    const signOnly: TxWallet = { address: payer.publicKey.toBase58(), signTransaction: vi.fn() };
    const prepare = vi.fn(async (input: Step) => walletStep(input.step));
    await render(stepAdapter(prepare), signOnly);
    await act(async () => { await steps().runSteps({ step: 1, prior: [] }, plan); });
    expect(steps()).toMatchObject({ status: "failed", error: WALLET_MUST_SEND });
    expect(signOnly.signTransaction).not.toHaveBeenCalled();
    expect(urls(fetchMock)).not.toContain("/api/tx-send");
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("no confirmation for step 1: step 2 is never prepared", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", network("pending"));
    const prepare = vi.fn(async (input: Step) => walletStep(input.step));
    await render(stepAdapter(prepare), wallet(undefined, vi.fn(async () => SIG)));
    let running!: Promise<unknown>;
    await act(async () => { running = steps().runSteps({ step: 1, prior: [] }, plan); await vi.advanceTimersByTimeAsync(10); });
    expect(steps()).toMatchObject({ status: "confirming", signature: SIG, locked: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(200_000); await running; });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(steps()).toMatchObject({ status: "failed", retryable: false });
    expect(steps().error).toMatch(/^Step 1 of 2 is still unconfirmed, so step 2 of 2 was not started/);
  });
});

describe("openStatusFromNotice", () => {
  it("maps the shared notice to the open modal status", () => {
    expect(openStatusFromNotice(undefined)).toBeNull();
    const base = { id: "x", flow: "open" as const, title: "" };
    expect(openStatusFromNotice({ ...base, state: "loading" })).toBe("pending");
    expect(openStatusFromNotice({ ...base, state: "success" })).toBe("confirmed");
    expect(openStatusFromNotice({ ...base, state: "failure", kind: "expired" })).toBe("expired");
    expect(openStatusFromNotice({ ...base, state: "failure", kind: "failed" })).toBe("failed");
    expect(openStatusFromNotice({ ...base, state: "failure", kind: "unknown" })).toBe("manual-review");
    expect(findTxNotice("none")).toBeUndefined();
  });
});
