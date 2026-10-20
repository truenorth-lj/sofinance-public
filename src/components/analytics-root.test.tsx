// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/",
  search: "",
  init: vi.fn(async () => true),
  pageview: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/lib/analytics/client", () => ({
  initGrowthAnalytics: mocks.init,
  capturePageview: mocks.pageview,
  captureGrowthEvent: mocks.capture,
}));

import { AnalyticsRoot } from "./analytics-root";
import { GROWTH_EVENTS } from "@/lib/analytics/events";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.pathname = "/";
  mocks.search = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("AnalyticsRoot pageviews", () => {
  it("captures a pageview on / and rwa_pairs_view with ref on /app/rwa-pairs", async () => {
    await act(async () => { root.render(createElement(AnalyticsRoot)); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.pageview).toHaveBeenCalledWith("/", expect.any(String));
    expect(mocks.capture).not.toHaveBeenCalled();

    mocks.pathname = "/app/rwa-pairs";
    mocks.search = "ref=x-thread";
    await act(async () => { root.render(createElement(AnalyticsRoot)); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.capture).toHaveBeenCalledWith(GROWTH_EVENTS.rwaPairsView, { ref: "x-thread" });
  });
});
