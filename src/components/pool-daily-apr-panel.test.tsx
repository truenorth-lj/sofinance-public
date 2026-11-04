// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolDailyAprChart } from "./pool-daily-apr-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
    poolId: "pool", label: "Pool fee APR (daily, estimated)", assumptions: "Daily volume × fee ÷ TVL.", feeRate: 0.0005,
    published: { dayFeeApr: 4.37, weekFeeApr: 3.91, monthFeeApr: 2.88 },
    points: [{ time: 1791331200, date: "2026-10-07", aprPct: 3.14 }, { time: 1791417600, date: "2026-10-08", aprPct: 3.99 }],
    sources: [], fetchedAt: "2026-10-09T06:00:00.000Z",
  }) })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("PoolDailyAprChart (position page)", () => {
  it("drops Raydium's 30d feeApr figure; keeps the daily chart and the position's realized fee APR overlay", async () => {
    await act(async () => {
      root.render(createElement(PoolDailyAprChart, { poolId: "pool", nowSeconds: 1791504000, overlay: {
        label: "Position realized fee APR (cumulative, on-chain events)", points: [{ time: 1791417600, date: "2026-10-08", value: 12.5 }] } }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const text = container.textContent ?? "";
    expect(text).toContain("Est. daily fee APR");
    expect(text).toContain("Position realized fee APR");
    expect(text).toContain("Raydium 7d feeApr 3.91%");
    expect(text).not.toMatch(/30d|2\.88/);
  });
});
