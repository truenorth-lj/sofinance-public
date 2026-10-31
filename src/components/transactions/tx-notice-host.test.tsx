// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn() }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));

import { getTxNotices, loadTxAttempts, reportTxFailure, resetTxNotices, saveTxAttempt, SUCCESS_NOTICE_MS, TxNotSentError } from "@/lib/tx-pipeline";
import { TransactionStatusDialog } from "@/components/transaction-status-dialog";
import { TxNoticeHost } from "./tx-notice-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const WALLET = "Wa11et1111111111111111111111111111111111111";
const SIG = bs58.encode(new Uint8Array(64).fill(6));
let root: Root; let container: HTMLElement; let status: string;
const fetchMock = vi.fn(async () => Response.json({ status }));

beforeEach(() => {
  vi.useFakeTimers(); resetTxNotices(); window.localStorage.clear(); status = "pending";
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("TxNoticeHost", () => {
  it("resumes a saved signature after reload, confirms it, clears it (no stale banner) and auto-dismisses", async () => {
    saveTxAttempt(window.localStorage, { version: 1, flow: "add", wallet: WALLET, signature: SIG, lastValidBlockHeight: 9,
      createdAt: Date.now(), successTitle: "Liquidity added" });
    await act(async () => root.render(createElement(TxNoticeHost, { wallet: WALLET })));
    expect(container.querySelector("[data-tx-notice=loading]")?.textContent).toContain("Checking a previous transaction");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`https://solscan.io/tx/${SIG}`);
    status = "confirmed"; await advance(2_100);
    expect(container.querySelector("[data-tx-notice=success]")?.textContent).toContain("Liquidity added");
    expect(loadTxAttempts(window.localStorage, WALLET)).toEqual([]);
    await advance(SUCCESS_NOTICE_MS + 10);
    expect(getTxNotices()).toEqual([]); expect(container.textContent).toBe("");
  });
  it("offers a one-tap retry on a not-sent failure", async () => {
    const retry = vi.fn();
    await act(async () => root.render(createElement(TxNoticeHost, { wallet: WALLET })));
    await act(async () => { reportTxFailure({ flow: "open", error: new TxNotSentError("Pool is paused"), retry }); });
    expect(container.querySelector("[data-tx-notice=failure]")?.textContent).toContain("Pool is paused. Nothing was sent.");
    await act(async () => (container.querySelector("[data-testid=tx-notice-retry]") as HTMLButtonElement).click());
    expect(retry).toHaveBeenCalledTimes(1); expect(getTxNotices()).toEqual([]);
  });
});

describe("TransactionStatusDialog", () => {
  const attempt = { signature: SIG, positionMint: "PositionMint1111111111111111111111111111111" };
  it("shows the expired message with Try again and a Solscan link", async () => {
    const onRetry = vi.fn();
    await act(async () => root.render(createElement(TransactionStatusDialog, { attempt, status: "expired", error: "", open: true, onOpenChange: vi.fn(), onRetry })));
    expect(container.textContent).toContain("expired before Solana included it");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`https://solscan.io/tx/${SIG}`);
    const retryButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => retryButton.click()); expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it("offers no retry while confirming or after success", async () => {
    for (const status of ["pending", "success"] as const) {
      await act(async () => root.render(createElement(TransactionStatusDialog, { attempt, status, error: "", open: true, onOpenChange: vi.fn(), onRetry: vi.fn() })));
      expect(container.textContent).not.toContain("Try again");
    }
    expect(container.textContent).toContain("Liquidity added");
  });
});
