// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degradedPayloadFixture, payloadFixture } from "@/lib/range-apr/payload.fixture";
import { clearPoolRangeAprClientCache } from "./pool-range-apr-client";
import { usePoolRangeApr } from "./use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let payloads: unknown[];
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payloads.shift() ?? payloadFixture() }));

function Probe() {
  const state = usePoolRangeApr("pool");
  return createElement("span", null, state.status === "ready" ? (state.data.sample.degraded ? "degraded" : "good") : state.status);
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  payloads = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  clearPoolRangeAprClientCache();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One retry cycle: the 20 s timer fires (act flushes the re-render), then the deferred load runs. */
async function retryCycle() {
  await advance(20_001);
  await advance(1);
  await advance(1);
}

describe("usePoolRangeApr", () => {
  it("re-asks after a degraded payload and swaps in the good one without a reload", async () => {
    payloads = [degradedPayloadFixture(), payloadFixture()];
    await act(async () => { root.render(createElement(Probe)); });
    await advance(1);
    expect(container.textContent).toBe("degraded");
    await retryCycle();
    expect(container.textContent).toBe("good");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after a few degraded answers instead of polling forever", async () => {
    payloads = Array.from({ length: 12 }, () => degradedPayloadFixture());
    await act(async () => { root.render(createElement(Probe)); });
    await advance(1);
    for (let i = 0; i < 7; i++) await retryCycle();
    expect(container.textContent).toBe("degraded");
    expect(fetchMock).toHaveBeenCalledTimes(5); // first load + 4 retries
  });
});
