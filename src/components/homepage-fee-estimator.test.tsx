import Decimal from "decimal.js";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESTIMATOR_UNAVAILABLE, HomepageFeeEstimator, estimatorPools } from "./homepage-fee-estimator";
import { shareCalcProjection } from "./unified-pools/share-calc-dialog";
import { poolPlanBasis, planAprLabel } from "./plan/pool-plan-basis";
import { clearPoolYieldMemory, type PoolYieldState } from "./plan/use-pool-yield";
import { formatInUnit, formatPct } from "./plan/format";
import { selectBestPlanApr } from "@/lib/lp-plan-best-apr";
import type { UnifiedPool } from "@/lib/unified-pools/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pool = (address: string, wrapped: string, plain: string, over: Partial<UnifiedPool> = {}): UnifiedPool => ({
  key: `solana:${address}`, chain: "solana", protocol: "raydium-clmm", poolAddress: address, pairLabel: `${wrapped}/${plain}`,
  symbolA: wrapped, symbolB: plain, nameA: wrapped, nameB: plain, mintA: `${address}-a`, mintB: `${address}-b`,
  feeTierBps: 25, tvlUsd: 50_000, volume24hUsd: 10_000, poolFeeApr24hPct: 5, ...over,
} as UnifiedPool);

// Homepage ranking (7-day card APR): USDC/USDT first, then SNDK, then SPCX. The stablecoin pool is never the default.
const usdc = pool("UsdcPool111", "USDC", "USDT", { usdPerShare: 1 });
const sndk = pool("SndkPool111", "SNDKx", "SNDK", { usdPerShare: 81.2 });
const spcx = pool("SpcxPool111", "SPCXx", "SPCX", { usdPerShare: 200 });
const CARD_APR: Record<string, number> = { [usdc.key]: 118.7, [sndk.key]: 64.2, [spcx.key]: 22.5 };
const apr7d = (p: UnifiedPool) => CARD_APR[p.key] ?? null;
const APR_STATES = Object.fromEntries(Object.entries(CARD_APR).map(([key, aprPct]) =>
  [key, { status: "ready" as const, aprPct, rangeLabel: "Standard (±0.3%)", lowConfidence: false, avgDailyVolumeUsd: null }]));
const ALL = [spcx, usdc, sndk];

const DAY = 86_400;
const FETCHED_AT = "2026-11-20T06:00:00.000Z";
const today = Math.floor(Date.parse(FETCHED_AT) / 1000 / DAY) * DAY;
const series = (days: number, aprPct: number, tvlUsd = 50_000) => Array.from({ length: days }, (_, i) => {
  const time = today - (days - i) * DAY;
  return { time, date: new Date(time * 1000).toISOString().slice(0, 10), aprPct: aprPct + (i % 3), volumeUsd: 20_000, tvlUsd };
});
const SERIES: Record<string, ReturnType<typeof series>> = { [usdc.poolAddress]: series(30, 9), [sndk.poolAddress]: series(30, 31), [spcx.poolAddress]: series(30, 18) };

let requested: string[] = [];
let answer: (poolId: string) => Response;
const ok = (poolId: string) => new Response(JSON.stringify({ poolId, points: SERIES[poolId], fetchedAt: FETCHED_AT }), { status: 200 });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  clearPoolYieldMemory();
  requested = [];
  answer = ok;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const poolId = new URL(String(input), "http://localhost").searchParams.get("poolId")!;
    requested.push(poolId);
    return answer(poolId);
  }));
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); });

async function settle(ms = 20) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}
async function render(pools: UnifiedPool[] = ALL) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<HomepageFeeEstimator pools={pools} apr={APR_STATES} apr7d={apr7d} />));
  await settle(350);
  return host;
}
const select = (el: HTMLElement) => el.querySelector("select") as HTMLSelectElement;
const choose = (el: HTMLElement, p: UnifiedPool) => act(() => {
  select(el).value = p.key;
  select(el).dispatchEvent(new Event("change", { bubbles: true }));
});
const presets = (el: HTMLElement) => [...el.querySelectorAll('[data-testid="estimator-presets"] button')].map((b) => b.textContent);
const readyFor = (p: UnifiedPool): PoolYieldState => ({
  status: "ready", poolId: p.poolAddress, fetchedAt: FETCHED_AT, latestTvlUsd: 50_000,
  best: selectBestPlanApr(SERIES[p.poolAddress]!, Date.parse(FETCHED_AT) / 1000)!,
});

describe("HomepageFeeEstimator", () => {
  it("starts on the homepage's top-ranked stock pool, never the stablecoin pool, with share quick amounts", async () => {
    expect(estimatorPools(ALL, apr7d).defaultPool?.key).toBe(sndk.key);
    const el = await render();
    expect(select(el).value).toBe(sndk.key);
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("10");
    expect(presets(el)).toEqual(["1", "10", "100"]);
  });

  it("shows the dialog's own numbers: the daily figure is the dialog's 1-day projection, captioned with its APR label", async () => {
    const el = await render();
    const basis = poolPlanBasis(sndk, readyFor(sndk));
    const dialogDay = shareCalcProjection(basis, "10", 1)!.best;
    const dialogWeek = shareCalcProjection(basis, "10", 7)!.best;
    const fees = el.querySelector('[data-testid="estimator-fees"]')!.textContent!;
    expect(fees).toContain(`Per day${formatInUnit(dialogDay.feesEarned, basis.unit)}`);
    expect(fees).toContain(`Per week${formatInUnit(dialogWeek.feesEarned, basis.unit)}`);
    expect(el.querySelector('[data-testid="estimator-basis"]')!.textContent).toBe(`${planAprLabel(basis.best!)} ${formatPct(dialogDay.cappedAprPct)}`);
    // Not compounded: a week is exactly seven days, and the caption is a day × 365 ÷ the amount.
    expect(new Decimal(dialogWeek.feesEarned).toFixed(15)).toBe(new Decimal(dialogDay.feesEarned).mul(7).toFixed(15));
    expect(new Decimal(dialogDay.cappedAprPct).toFixed(10)).toBe(new Decimal(dialogDay.feesEarned).mul(365).div(10).mul(100).toFixed(10));
    expect(el.querySelectorAll('[data-testid="estimator-usd"]').length).toBe(2);
    expect(el.textContent).toContain("Assumes price stays in range. Not a prediction. Fees not guaranteed.");
  });

  it("waits for the homepage ranking to settle before reading the default pool, then reads only that one", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const loading = { ...APR_STATES, [spcx.key]: { status: "loading" as const } };
    act(() => root!.render(<HomepageFeeEstimator pools={ALL} apr={loading} apr7d={apr7d} />));
    await settle(400);
    expect(requested).toEqual([]);
    act(() => root!.render(<HomepageFeeEstimator pools={ALL} apr={APR_STATES} apr7d={apr7d} />));
    await settle(400);
    expect(requested).toEqual([sndk.poolAddress]);
  });

  it("reads only the selected pool, waits ~300ms after switching, and reuses what it already read", async () => {
    const el = await render();
    expect(requested).toEqual([sndk.poolAddress]);
    choose(el, spcx);
    await settle(100);
    choose(el, usdc);
    await settle(100);
    expect(requested).toEqual([sndk.poolAddress]); // still waiting: no request for SPCX or USDC yet
    await settle(300);
    expect(requested).toEqual([sndk.poolAddress, usdc.poolAddress]); // SPCX was skipped over, never read
    choose(el, sndk);
    await settle(400);
    expect(requested).toEqual([sndk.poolAddress, usdc.poolAddress]); // from memory
    expect(el.querySelector('[data-testid="estimator-fees"]')).not.toBeNull();
  });

  it("switches to USDC amounts (100 / 1K / 10K, 1,000 by default) on the stablecoin pool", async () => {
    const el = await render();
    choose(el, usdc);
    await settle(350);
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("1000");
    expect(presets(el)).toEqual(["100", "1K", "10K"]);
    expect(el.querySelector('[data-testid="estimator-fees"]')!.textContent).toContain("USDC");
  });

  it.each([
    ["a 429", () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 })],
    ["an error", () => new Response(JSON.stringify({ error: "Upstream request failed (502)" }), { status: 502 })],
    ["too little data", (poolId: string) => new Response(JSON.stringify({ poolId, points: series(3, 31), fetchedAt: FETCHED_AT }), { status: 200 })],
    ["no data days", (poolId: string) => new Response(JSON.stringify({ poolId, points: [], fetchedAt: FETCHED_AT }), { status: 200 })],
  ])("on %s says the estimate is unavailable, with no number and never the card's APR", async (_name, respond) => {
    answer = respond;
    const el = await render();
    expect(el.querySelector('[data-testid="estimator-unavailable"]')!.textContent).toBe(ESTIMATOR_UNAVAILABLE);
    expect(el.querySelector('[data-testid="estimator-fees"]')).toBeNull();
    expect(el.querySelector('[data-testid="estimator-basis"]')).toBeNull();
    expect(el.textContent).not.toMatch(/64\.2|APR/);
  });
});
