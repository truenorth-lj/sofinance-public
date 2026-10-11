import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degradedPayloadFixture, payloadFixture } from "@/lib/range-apr/payload.fixture";
import { clearPoolRangeAprClientCache, loadPoolRangeApr } from "./pool-range-apr-client";

let payloads: unknown[];
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payloads.shift() }));

beforeEach(() => {
  vi.useFakeTimers();
  payloads = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  clearPoolRangeAprClientCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("loadPoolRangeApr cache", () => {
  it("serves a good payload for a minute without asking again", async () => {
    payloads = [payloadFixture()];
    await loadPoolRangeApr("pool");
    vi.advanceTimersByTime(59_000);
    await loadPoolRangeApr("pool");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a degraded payload only a few seconds, so the next ask reaches the server", async () => {
    payloads = [degradedPayloadFixture(), payloadFixture()];
    expect((await loadPoolRangeApr("pool")).sample.degraded).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect((await loadPoolRangeApr("pool")).sample.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4_000);
    expect((await loadPoolRangeApr("pool")).sample.degraded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
