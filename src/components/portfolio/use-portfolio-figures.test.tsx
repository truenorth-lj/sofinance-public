// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePortfolioFigures } from "./use-portfolio-figures";
import { notifyPositionHistoryChange, readPositionHistoryRefresh } from "@/lib/position-history-refresh";
import type { PortfolioPosition } from "@/lib/portfolio/model";
const mint = "11111111111111111111111111111111";
const key = `raydium-clmm:${mint}`;
const row = (valueUsd = 10): PortfolioPosition => ({ key, status: "ready", figures: { stock: "TSLA", shares: 1, valueUsd, unclaimedFeesUsd: 1, cumulativeFeesUsd: 2 },
  evaluatedAt: "2026-11-15T00:00:00Z", historyComplete: true, historyRefreshResolved: true });
let container: HTMLDivElement, root: Root;
let latest: ReturnType<typeof usePortfolioFigures>;
const fetchMock = vi.fn();
function Probe({ wallet, refresh = 0, paused = false }: { wallet: string | null; refresh?: number; paused?: boolean }) {
  const rows = usePortfolioFigures(wallet, [key], { refresh, paused });
  useEffect(() => { latest = rows; }, [rows]);
  return createElement("div", null, rows[key]?.figures.valueUsd ?? "loading");
}
const render = async (wallet: string | null, refresh = 0, paused = false) => act(async () => root.render(createElement(Probe, { wallet, refresh, paused })));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("Portfolio client request lifecycle", () => {
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
  it("keeps failed/missing rows explicit instead of counting them as zero", async () => {
    fetchMock.mockResolvedValue(Response.json({ wallet: "A", positions: [] }));
    await render("A"); expect(latest[key]?.status).toBe("failed"); expect(latest[key]?.figures.valueUsd).toBeNull();
  });
});
