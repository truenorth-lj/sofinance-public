"use client";

import { useEffect, useState } from "react";
import { MAX_PORTFOLIO_POSITIONS, PORTFOLIO_POLL_DELAYS_MS, portfolioPositionSchema, type PortfolioPosition, type PortfolioResponse } from "@/lib/portfolio/model";
import { clearPositionHistoryRefresh, POSITION_HISTORY_REFRESH_EVENT, POSITION_HISTORY_REFRESH_STORAGE_KEY, readPositionHistoryRefresh } from "@/lib/position-history-refresh";
import { positionFigures } from "@/lib/portfolio/figures";
import { retainCumulativeFees } from "@/lib/portfolio/retain-cumulative-fees";

type Loaded = { wallet: string; rows: Record<string, PortfolioPosition> };
const failed = (key: string): PortfolioPosition => ({ key, status: "failed", figures: positionFigures(null), evaluatedAt: null, historyComplete: false, historyRefreshResolved: false });
const MAX_POLL_ROUNDS = PORTFOLIO_POLL_DELAYS_MS.length;
const MAX_REQUESTS = 8;
function waitForPoll(signal: AbortSignal, delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(ready); };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
const stopped = (row: PortfolioPosition): PortfolioPosition => row.historyStatus === "updating"
  ? { ...row, historyStatus: row.historyUpdatedAt ? "stale" : "unavailable" } : row;

/** One aggregate for normal portfolios; larger wallets use bounded sequential pages with progressive results. */
export function usePortfolioFigures(wallet: string | null, keys: readonly string[], { refresh, paused }: { refresh: number; paused: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const keyList = keys.join("|");
  useEffect(() => {
    const changed = () => setHistoryRevision((value) => value + 1);
    const storage = (event: StorageEvent) => { if (event.key === POSITION_HISTORY_REFRESH_STORAGE_KEY) changed(); };
    window.addEventListener(POSITION_HISTORY_REFRESH_EVENT, changed);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener(POSITION_HISTORY_REFRESH_EVENT, changed); window.removeEventListener("storage", storage); };
  }, []);
  useEffect(() => {
    if (!wallet || !keyList || paused) return;
    const controller = new AbortController();
    const wanted = [...new Set(keyList.split("|"))];
    const maxRequests = Math.max(MAX_REQUESTS, Math.ceil(wanted.length / MAX_PORTFOLIO_POSITIONS));
    const markers = new Map(wanted.map((key) => [key, readPositionHistoryRefresh(key.split(":")[1]!)]));
    const keep = (row: PortfolioPosition) => retainCumulativeFees(wallet, row);
    void (async () => {
      const rows: Record<string, PortfolioPosition> = {};
      let pending = wanted, requests = 0;
      for (let round = 0; round <= MAX_POLL_ROUNDS && pending.length; round++) {
        if (round && !await waitForPoll(controller.signal, PORTFOLIO_POLL_DELAYS_MS[round - 1]!)) return;
        const next: string[] = [];
        for (let offset = 0; offset < pending.length; offset += MAX_PORTFOLIO_POSITIONS) {
          if (controller.signal.aborted) return;
          const batch = pending.slice(offset, offset + MAX_PORTFOLIO_POSITIONS);
          if (requests >= maxRequests) { for (const key of batch) rows[key] = keep(rows[key] ? stopped(rows[key]!) : failed(key)); continue; }
          requests++;
          try {
            const response = await fetch("/api/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: controller.signal,
              body: JSON.stringify({ wallet, positions: batch.map((key) => ({ key,
                ...(markers.get(key)?.signatures.length ? { afterSignatures: markers.get(key)!.signatures } : {}),
                ...(rows[key]?.historyRefreshAfter ? { refreshAfter: rows[key]!.historyRefreshAfter } : {}) })),
                fresh: round === 0 && (refresh > 0 || batch.some((key) => markers.get(key))) }) });
            const body = await response.json() as PortfolioResponse;
            if (!response.ok || body.wallet !== wallet || !Array.isArray(body.positions)) throw new Error("Portfolio unavailable");
            if (controller.signal.aborted) return;
            for (const key of batch) {
              const checked = portfolioPositionSchema.safeParse(body.positions.find((item) => item.key === key));
              if (!checked.success) throw new Error("Invalid Portfolio row");
              if (round && checked.data.status === "failed" && rows[key]) {
                rows[key] = keep(stopped(rows[key]!));
                continue;
              }
              rows[key] = keep(checked.data);
              const marker = markers.get(key);
              const acknowledged = rows[key]!.historyComplete && rows[key]!.historyRefreshResolved;
              if (marker && rows[key]!.status !== "failed" && acknowledged) clearPositionHistoryRefresh(key.split(":")[1]!, marker.version);
              if (rows[key]!.historyStatus === "updating") next.push(key);
            }
          } catch {
            if (controller.signal.aborted) return;
            for (const key of batch) rows[key] = keep(round && rows[key] ? stopped(rows[key]!) : failed(key));
          }
          setLoaded({ wallet, rows: { ...rows } });
        }
        pending = next.filter((key) => rows[key]?.historyStatus === "updating");
        if (round === MAX_POLL_ROUNDS || requests >= maxRequests) {
          for (const key of pending) rows[key] = keep(stopped(rows[key]!));
          setLoaded({ wallet, rows: { ...rows } });
          break;
        }
      }
    })();
    return () => controller.abort();
  }, [wallet, keyList, refresh, paused, historyRevision]);
  return loaded?.wallet === wallet ? loaded.rows : {};
}
