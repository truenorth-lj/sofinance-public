"use client";

import { useEffect, useState } from "react";

export function useSolUsdcPrices() {
  const [prices, setPrices] = useState<{ rate: number | null; usdcUsd: number | null }>({ rate: null, usdcUsd: null });
  useEffect(() => {
    let active = true;
    let lastSuccess = 0;
    const expire = () => {
      if (active && Date.now() - lastSuccess >= 120_000) setPrices({ rate: null, usdcUsd: null });
    };
    let pending: AbortController | null = null;
    let timer: number | undefined;
    async function refresh() {
      let succeeded = false;
      pending?.abort();
      pending = new AbortController();
      expire();
      try {
        const response = await fetch("/api/sol-usdc-price", { signal: AbortSignal.any([pending.signal, AbortSignal.timeout(8_000)]), cache: "no-store" });
        if (!response.ok) throw new Error("Price unavailable");
        const price = await response.json();
        if (typeof price.rate !== "number" || !Number.isFinite(price.rate) || price.rate <= 0) throw new Error("Price unavailable");
        if (active) {
          lastSuccess = Date.now();
          succeeded = true;
          setPrices({
            rate: price.rate,
            usdcUsd: typeof price.usdcUsd === "number" && Number.isFinite(price.usdcUsd) && price.usdcUsd > 0 ? price.usdcUsd : null,
          });
        }
      } catch {
        expire();
      } finally {
        if (active) timer = window.setTimeout(() => { void refresh(); }, succeeded ? 60_000 : 10_000);
      }
    }
    void refresh();
    return () => { active = false; pending?.abort(); window.clearTimeout(timer); };
  }, []);
  return prices;
}

export function useSolUsdcPrice() {
  return useSolUsdcPrices().rate;
}
