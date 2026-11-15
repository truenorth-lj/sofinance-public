// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePortfolioFigures } from "./use-portfolio-figures";
import { notifyPositionHistoryChange, readPositionHistoryRefresh } from "@/lib/position-history-refresh";
import { PublicKey } from "@solana/web3.js";
import type { PortfolioPosition } from "@/lib/portfolio/model";
const mint = "11111111111111111111111111111111";
const key = `raydium-clmm:${mint}`;
const row = (valueUsd = 10): PortfolioPosition => ({ key, status: "ready", figures: { stock: "TSLA", shares: 1, valueUsd, unclaimedFeesUsd: 1, cumulativeFeesUsd: 2 },
  evaluatedAt: "2026-11-15T00:00:00Z", historyComplete: true, historyRefreshResolved: true });
let container: HTMLDivElement, root: Root;
let latest: ReturnType<typeof usePortfolioFigures>;
const fetchMock = vi.fn();
function Probe({ wallet, refresh = 0, paused = false, keys = [key] }: { wallet: string | null; refresh?: number; paused?: boolean; keys?: string[] }) {
  const rows = usePortfolioFigures(wallet, keys, { refresh, paused });
  useEffect(() => { latest = rows; }, [rows]);
  return createElement("div", null, rows[key]?.figures.valueUsd ?? "loading");
}
const render = async (wallet: string | null, refresh = 0, paused = false) => act(async () => root.render(createElement(Probe, { wallet, refresh, paused })));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Portfolio client request lifecycle", () => {
  it("shows saved figures immediately, polls with the original barrier, and clears a marker only after checked", async () => {
    vi.useFakeTimers();
    notifyPositionHistoryChange(mint);
    const barrier = "2026-11-15T00:01:00Z";
    fetchMock.mockResolvedValueOnce(Response.json({ wallet: "A", positions: [{ ...row(), historyStatus: "updating",
      historyUpdatedAt: "2026-11-15T00:00:00Z", historyRefreshAfter: barrier, historyRefreshResolved: false }] }))
      .mockResolvedValueOnce(Response.json({ wallet: "A", positions: [{ ...row(20), historyStatus: "fresh", historyRefreshAfter: barrier }] }));
    await render("A");
    expect(container.textContent).toBe("10"); expect(readPositionHistoryRefresh(mint)).not.toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).fresh).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ fresh: false, positions: [{ key, refreshAfter: barrier }] });
    expect(container.textContent).toBe("20"); expect(readPositionHistoryRefresh(mint)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("stops after three follow-ups and retains explicit stale data and unresolved markers", async () => {
    vi.useFakeTimers(); notifyPositionHistoryChange(mint);
    const pending = { ...row(), historyStatus: "updating", historyUpdatedAt: "2026-11-15T00:00:00Z", historyRefreshResolved: false };
    fetchMock.mockImplementation(async () => Response.json({ wallet: "A", positions: [pending] }));
    await render("A");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(4); expect(latest[key]?.historyStatus).toBe("stale");
    expect(container.textContent).toBe("10"); expect(readPositionHistoryRefresh(mint)).not.toBeNull();
  });
  it("cancels a pending poll when switching wallet or pausing", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ wallet: "A", positions: [{ ...row(), historyStatus: "updating" }] }))
      .mockResolvedValueOnce(Response.json({ wallet: "B", positions: [row(20)] }));
    await render("A"); await render("B");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(container.textContent).toBe("20");
    fetchMock.mockResolvedValueOnce(Response.json({ wallet: "B", positions: [{ ...row(30), historyStatus: "updating" }] }));
    await render("B", 1); await render("B", 1, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("preserves available figures and stops when a follow-up fails", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ wallet: "A", positions: [{ ...row(), historyStatus: "updating", historyUpdatedAt: "2026-11-15T00:00:00Z" }] }))
      .mockResolvedValueOnce(Response.json({ error: "rate limited" }, { status: 429 }));
    await render("A");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(container.textContent).toBe("10"); expect(latest[key]?.historyStatus).toBe("stale");
  });
  it("keeps available figures when an HTTP-successful poll contains a failed position", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ wallet: "A", positions: [{ ...row(), historyStatus: "updating", historyUpdatedAt: "2026-11-15T00:00:00Z" }] }))
      .mockResolvedValueOnce(Response.json({ wallet: "A", positions: [{ ...row(), status: "failed",
        figures: { stock: null, shares: null, valueUsd: null, unclaimedFeesUsd: null, cumulativeFeesUsd: null },
        historyComplete: false, historyRefreshResolved: false }] }));
    await render("A"); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(container.textContent).toBe("10");
    expect(latest[key]?.historyStatus).toBe("stale"); expect(latest[key]?.status).toBe("ready");
  });
  it("waits for discovery, sends one request, and does not refetch on incidental renders", async () => {
    fetchMock.mockResolvedValue(Response.json({ wallet: "A", positions: [row()] }));
    await render("A", 0, true); expect(fetchMock).not.toHaveBeenCalled();
    await render("A"); expect(fetchMock).toHaveBeenCalledTimes(1); expect(container.textContent).toBe("10");
    await render("A"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("aborts superseded reads and never publishes an old refresh or another wallet's response", async () => {
    const finish: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    await render("A"); await render("A", 1);
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    await act(async () => finish[1]!(Response.json({ wallet: "A", positions: [row(20)] })));
    await act(async () => finish[0]!(Response.json({ wallet: "A", positions: [row(1)] })));
    expect(container.textContent).toBe("20");
    await render("B"); expect(container.textContent).toBe("loading");
    await act(async () => finish[2]!(Response.json({ wallet: "A", positions: [row(999)] })));
    expect(latest[key]?.status).toBe("failed");
    await render(null); expect(Object.keys(latest)).toEqual([]);
  });
  it("passes transaction markers, rejects malformed rows, and clears only the resolved marker version", async () => {
    notifyPositionHistoryChange(mint);
    const finish: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    await render("A");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).fresh).toBe(true);
    await act(async () => finish[0]!(Response.json({ wallet: "A", positions: [{ ...row(), figures: {} }] })));
    expect(latest[key]?.status).toBe("failed"); expect(readPositionHistoryRefresh(mint)).not.toBeNull();
    await render("A", 1);
    await act(async () => finish[1]!(Response.json({ wallet: "A", positions: [row()] })));
    expect(readPositionHistoryRefresh(mint)).toBeNull();
    expect(latest[key]?.status).toBe("ready");
  });
  it("retains signature-less markers on partial history even when a response claims refresh resolution", async () => {
    notifyPositionHistoryChange(mint);
    fetchMock.mockResolvedValueOnce(Response.json({ wallet: "A", positions: [{ ...row(), status: "partial", historyComplete: false, historyRefreshResolved: true }] }));
    await render("A");
    expect(readPositionHistoryRefresh(mint)).not.toBeNull();
  });
  it("pages wallets above the request bound and publishes completed pages while the next waits", async () => {
    const keys = Array.from({ length: 51 }, (_, n) => `raydium-clmm:${new PublicKey(Buffer.alloc(32, n)).toBase58()}`);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(async () => Response.json({ wallet: "A", positions: keys.slice(0, 50).map((key) => ({ ...row(), key })) }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => root.render(createElement(Probe, { wallet: "A", keys })));
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).positions.length)).toEqual([50, 1]);
    expect(Object.keys(latest)).toHaveLength(50);
    await act(async () => finish(Response.json({ wallet: "A", positions: [{ ...row(), key: keys[50] }] })));
    expect(Object.keys(latest)).toHaveLength(51);
    expect(Object.values(latest).every((value) => value.status === "ready")).toBe(true);
  });
  it("keeps failed/missing rows explicit instead of counting them as zero", async () => {
    fetchMock.mockResolvedValue(Response.json({ wallet: "A", positions: [] }));
    await render("A"); expect(latest[key]?.status).toBe("failed"); expect(latest[key]?.figures.valueUsd).toBeNull();
  });
});
