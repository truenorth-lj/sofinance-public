"use client";

import { useEffect, useState } from "react";
import { MAX_PORTFOLIO_POSITIONS, portfolioPositionSchema, type PortfolioPosition, type PortfolioResponse } from "@/lib/portfolio/model";
import { clearPositionHistoryRefresh, POSITION_HISTORY_REFRESH_EVENT, POSITION_HISTORY_REFRESH_STORAGE_KEY, readPositionHistoryRefresh } from "@/lib/position-history-refresh";
import { positionFigures } from "@/lib/portfolio/figures";

type Loaded = { wallet: string; rows: Record<string, PortfolioPosition> };
const failed = (key: string): PortfolioPosition => ({ key, status: "failed", figures: positionFigures(null), evaluatedAt: null, historyComplete: false, historyRefreshResolved: false });

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
    const markers = new Map(wanted.map((key) => [key, readPositionHistoryRefresh(key.split(":")[1]!)]));
    void (async () => {
      const rows: Record<string, PortfolioPosition> = {};
      for (let offset = 0; offset < wanted.length; offset += MAX_PORTFOLIO_POSITIONS) {
        if (controller.signal.aborted) return;
        const batch = wanted.slice(offset, offset + MAX_PORTFOLIO_POSITIONS);
        try {
          const response = await fetch("/api/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: controller.signal,
            body: JSON.stringify({ wallet, positions: batch.map((key) => ({ key, ...(markers.get(key)?.signatures.length ? { afterSignatures: markers.get(key)!.signatures } : {}) })),
              fresh: refresh > 0 || batch.some((key) => markers.get(key)) }) });
          const body = await response.json() as PortfolioResponse;
          if (!response.ok || body.wallet !== wallet || !Array.isArray(body.positions)) throw new Error("Portfolio unavailable");
          if (controller.signal.aborted) return;
          for (const key of batch) {
            const checked = portfolioPositionSchema.safeParse(body.positions.find((item) => item.key === key));
            rows[key] = checked.success ? checked.data : failed(key);
            const marker = markers.get(key);
            const acknowledged = marker?.signatures.length ? rows[key]!.historyRefreshResolved : rows[key]!.historyComplete;
            if (marker && rows[key]!.status !== "failed" && acknowledged) clearPositionHistoryRefresh(key.split(":")[1]!, marker.version);
          }
        } catch {
          if (controller.signal.aborted) return;
          for (const key of batch) rows[key] = failed(key);
        }
        setLoaded({ wallet, rows: { ...rows } });
      }
    })();
    return () => controller.abort();
  }, [wallet, keyList, refresh, paused, historyRevision]);
  return loaded?.wallet === wallet ? loaded.rows : {};
}
