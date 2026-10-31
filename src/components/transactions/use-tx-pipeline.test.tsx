// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn(), captureTxWalletErrorLanded: vi.fn() }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));

import { dismissTxNotice, findTxNotice, getTxNotices, noticeIdFor, resetTxNotices, settleTxNotice, SUCCESS_NOTICE_MS, TxNotSentError, type TxAdapter, type TxWallet } from "@/lib/tx-pipeline";
import { TxNoticeHost } from "./tx-notice-host";
import { openStatusFromNotice } from "@/components/use-open-attempt";
import { useTxPipeline } from "./use-tx-pipeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const payer = testKeypair(41);
const SIG = bs58.encode(new Uint8Array(64).fill(4));
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const wallet = (address = payer.publicKey.toBase58(), send = vi.fn(async () => SIG)): TxWallet => ({ address, signTransaction: vi.fn(), signAndSendTransaction: send });

let root: Root; let container: HTMLElement; const box = {} as { current: ReturnType<typeof useTxPipeline<number, never>> };
function Harness(props: { adapter: TxAdapter<number>; wallet: TxWallet | null }) {
  const value = useTxPipeline(props.adapter as never, props.wallet) as never;
  useLayoutEffect(() => { box.current = value; });
  return null;
}
const render = async (adapter: TxAdapter<number>, w: TxWallet | null) => act(async () => root.render(createElement(Harness, { adapter, wallet: w })));
const adapter = (prepare: TxAdapter<number>["prepare"]): TxAdapter<number> => ({ flow: "add", successTitle: "Liquidity added", prepare });
const prepared = () => ({ transaction: buildTransaction({ payer, signWith: [] }), lastValidBlockHeight: 1 });

beforeEach(() => { resetTxNotices(); window.localStorage.clear(); container = document.createElement("div"); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); });

describe("useTxPipeline", () => {
  // The toast is not the source of truth: the dialog must keep the result after the toast closes.
  describe("keeps the settled result after its toast closes", () => {
    const withHost = async (a: TxAdapter<number>, w: TxWallet) => act(async () => root.render(createElement("div", null,
      createElement(Harness, { adapter: a, wallet: w }), createElement(TxNoticeHost, { wallet: w.address }))));
    beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "pending" }))); });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it("still shows success after the success toast auto-closes (SUCCESS_NOTICE_MS)", async () => {
      await withHost(adapter(async () => prepared()), wallet());
      await act(async () => { await box.current.run(1); });
      expect(box.current.status).toBe("confirming");
      await act(async () => { settleTxNotice(noticeIdFor(SIG), "confirmed"); });
      expect(box.current).toMatchObject({ status: "success", kind: "landed", signature: SIG });
      await act(async () => { await vi.advanceTimersByTimeAsync(SUCCESS_NOTICE_MS + 10); });
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
    const prepare = vi.fn(async () => ({ ...prepared(), sendPermit: "permit" }));
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
