// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { HomepageFeeEstimator } from "./homepage-fee-estimator";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pool = (over: Partial<UnifiedPool>): UnifiedPool => ({
  key: "solana:A", chain: "solana", protocol: "raydium-clmm", poolAddress: "A", pairLabel: "SPCXx/SPCX",
  ...over,
} as UnifiedPool);

const ready = (aprPct: number, extra: Partial<Extract<Apr7dState, { status: "ready" }>> = {}): Apr7dState =>
  ({ status: "ready", aprPct, rangeLabel: "±1%", lowConfidence: false, avgDailyVolumeUsd: null, ...extra });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function render(pools: UnifiedPool[], apr: Record<string, Apr7dState>, defaultPoolKey?: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const apr7d = (p: UnifiedPool) => { const s = apr[p.key]; return s?.status === "ready" ? s.aprPct : null; };
  act(() => root!.render(<HomepageFeeEstimator pools={pools} apr={apr} apr7d={apr7d} defaultPoolKey={defaultPoolKey} />));
  return host;
}

const spcx = pool({ usdPerShare: 200 });
const usdc = pool({ key: "solana:B", poolAddress: "B", pairLabel: "USDC/USDT", usdPerShare: 1 });
const rhc = pool({ key: "robinhood:C", chain: "robinhood", protocol: "uniswap-v4-rhc", poolAddress: "C", pairLabel: "TSLAx/TSLA" });
const unpriced = pool({ key: "solana:D", protocol: "meteora-dlmm", poolAddress: "D", pairLabel: "INTCx/INTC" });

describe("HomepageFeeEstimator", () => {
  it("shows the day and week fees in the stock, with ≈$ when the share price is known, and the mandated copy", () => {
    const el = render([spcx], { [spcx.key]: ready(36.5) });
    expect(el.textContent).toContain("Estimated fees collected");
    expect(el.textContent).toContain("Assumes price stays in range. Not a prediction. Fees not guaranteed.");
    expect(el.textContent).toContain("±1% range · 7-day average fee APR 36.5%");
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("10");
    const fees = el.querySelector('[data-testid="estimator-fees"]')!.textContent!;
    // 10 SPCX at 36.5%/yr compounded daily: ≈0.01 SPCX a day, ≈0.07 a week.
    expect(fees).toMatch(/Per day\+?0\.01\d* SPCX/);
    expect(fees).toMatch(/Per week\+?0\.07\d* SPCX/);
    expect(el.querySelectorAll('[data-testid="estimator-usd"]').length).toBe(2);
  });

  it("drops ≈$ when the share price is unknown and caps at the pool's own daily LP fees when priced", () => {
    let el = render([unpriced], { [unpriced.key]: ready(36.5) });
    expect(el.querySelector('[data-testid="estimator-fees"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="estimator-usd"]').length).toBe(0);
    act(() => root?.unmount()); host?.remove();
    // 10 SPCX = $2,000; the pool's LPs took $0.20/day in all, so the day can't exceed 0.001 SPCX.
    el = render([spcx], { [spcx.key]: ready(36.5, { poolLpFeesPerDayUsd: 0.2 }) });
    expect(el.querySelector('[data-testid="estimator-fees"]')!.textContent).toMatch(/Per day\+?0\.001 SPCX/);
  });

  it("only offers calculator pools with a 7-day estimate, and USDC amounts for the stablecoin pool", () => {
    const el = render([spcx, usdc, rhc, unpriced], { [usdc.key]: ready(5), [spcx.key]: ready(36.5), [rhc.key]: ready(90) }, usdc.key);
    const options = [...el.querySelectorAll("option")];
    expect(options.map((o) => o.textContent)).not.toContain("TSLAx/TSLA");
    expect(options.find((o) => o.value === unpriced.key)?.disabled).toBe(true);
    expect((el.querySelector("select") as HTMLSelectElement).value).toBe(usdc.key);
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("1000");
    expect(el.querySelector('[data-testid="estimator-fees"]')!.textContent).toContain("USDC");
  });

  it("renders nothing when no pool has a 7-day estimate yet", () => {
    const el = render([spcx], {});
    expect(el.querySelector('[data-testid="homepage-fee-estimator"]')).toBeNull();
  });
});
