import { describe, expect, it, vi } from "vitest";
import { isRetryableFailure, retryJson, type JsonResult } from "./upstream-retry";

const fail = (reason: string): JsonResult => ({ ok: false, reason });
const options = { sleep: vi.fn(async (ms: number) => { void ms; }), random: () => 0.5 };

describe("isRetryableFailure", () => {
  it("retries rate limits, server errors and network problems but not 404s", () => {
    for (const reason of ["Upstream request failed (429)", "Upstream request failed (503)", "The operation was aborted due to timeout", "fetch failed"]) {
      expect(isRetryableFailure(reason), reason).toBe(true);
    }
    for (const reason of ["Upstream request failed (404)", "Upstream request failed (400)", "Unexpected token"]) {
      expect(isRetryableFailure(reason), reason).toBe(false);
    }
  });
});

describe("retryJson", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(async (ms: number) => { void ms; });
    const once = vi.fn(async (): Promise<JsonResult> => ({ ok: true, body: 1 }));
    await expect(retryJson(once, { ...options, sleep })).resolves.toEqual({ ok: true, body: 1 });
    expect(once).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 429 with growing backoff and succeeds", async () => {
    const sleep = vi.fn(async (ms: number) => { void ms; });
    const once = vi.fn<() => Promise<JsonResult>>()
      .mockResolvedValueOnce(fail("Upstream request failed (429)"))
      .mockResolvedValueOnce(fail("Upstream request failed (429)"))
      .mockResolvedValueOnce({ ok: true, body: "ok" });
    await expect(retryJson(once, { ...options, sleep })).resolves.toEqual({ ok: true, body: "ok" });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([400, 800]);
  });

  it("gives up after the attempt budget and reports the last failure", async () => {
    const once = vi.fn(async () => fail("Upstream request failed (429)"));
    await expect(retryJson(once, { ...options, attempts: 3 })).resolves.toEqual(fail("Upstream request failed (429)"));
    expect(once).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable failure", async () => {
    const once = vi.fn(async () => fail("Upstream request failed (404)"));
    await retryJson(once, options);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("caps the backoff", async () => {
    const sleep = vi.fn(async (ms: number) => { void ms; });
    await retryJson(async () => fail("Upstream request failed (503)"), { ...options, sleep, attempts: 6, baseDelayMs: 1000, maxDelayMs: 2000 });
    expect(Math.max(...sleep.mock.calls.map(([ms]) => ms as number))).toBeLessThanOrEqual(2000 * 1.25);
  });
});
