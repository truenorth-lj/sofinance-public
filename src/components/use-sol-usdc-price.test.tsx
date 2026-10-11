// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSolUsdcPrices } from "./use-sol-usdc-price";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("retries a missing initial estimate after ten seconds", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("temporary outage"))
    .mockResolvedValue(Response.json({ rate: 150, usdcUsd: 0.99 }));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div"), root = createRoot(container);
  function Price() { return createElement("span", null, String(useSolUsdcPrices().rate)); }
  try {
    await act(async () => { root.render(createElement(Price)); });
    expect(container.textContent).toBe("null");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(container.textContent).toBe("150");
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { await act(async () => { root.unmount(); }); }
});

it("keeps a recent reference price during refresh and a transient outage, but expires it", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let fail = false;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (fail) throw new Error("temporary outage");
    return Response.json({ rate: 150, usdcUsd: 0.99 });
  }));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Price() { return createElement("span", null, String(useSolUsdcPrices().rate)); }
  try {
    await act(async () => { root.render(createElement(Price)); });
    expect(container.textContent).toBe("150");
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(container.textContent).toBe("150");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(container.textContent).toBe("null");
  } finally { await act(async () => { root.unmount(); }); }
});
