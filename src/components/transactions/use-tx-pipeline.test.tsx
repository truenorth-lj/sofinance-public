// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn() }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));

import { findTxNotice, getTxNotices, noticeIdFor, resetTxNotices, settleTxNotice, TxNotSentError, type TxAdapter, type TxWallet } from "@/lib/tx-pipeline";
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
  it("returns to idle on a wallet rejection", async () => {
    await render(adapter(async () => prepared()), wallet(undefined, vi.fn(async () => { throw new Error("User rejected the request."); })));
    await act(async () => { await box.current.run(1); });
    expect(box.current.status).toBe("idle"); expect(getTxNotices()).toEqual([]);
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
