"use client";

import { useEffect, useState } from "react";

export function useSolUsdcPrices() {
  const [prices, setPrices] = useState<{ rate: number | null; usdcUsd: number | null }>({ rate: null, usdcUsd: null });
  useEffect(() => {
    let active = true;
    let pending: AbortController | null = null;
    async function refresh() {
      pending?.abort();
      pending = new AbortController();
      try {
        const response = await fetch("/api/sol-usdc-price", { signal: AbortSignal.any([pending.signal, AbortSignal.timeout(8_000)]), cache: "no-store" });
        if (!response.ok) throw new Error("Price unavailable");
        const price = await response.json();
        if (active) setPrices({
          rate: typeof price.rate === "number" && Number.isFinite(price.rate) && price.rate > 0 ? price.rate : null,
          usdcUsd: typeof price.usdcUsd === "number" && Number.isFinite(price.usdcUsd) && price.usdcUsd > 0 ? price.usdcUsd : null,
        });
      } catch {
        if (active) setPrices({ rate: null, usdcUsd: null });
      }
    }
    void refresh();
    const timer = window.setInterval(() => { setPrices({ rate: null, usdcUsd: null }); void refresh(); }, 60_000);
    return () => { active = false; pending?.abort(); window.clearInterval(timer); };
  }, []);
  return prices;
}

export function useSolUsdcPrice() {
  return useSolUsdcPrices().rate;
}
