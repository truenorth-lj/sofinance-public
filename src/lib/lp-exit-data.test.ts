import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { resetRpcCache } from "./rpc/cache";
import { coalesceExitPreview, EXIT_PREVIEW_TTL_MS, exitPreviewCacheKey } from "./lp-exit-data";

afterEach(() => {
  resetRpcCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("exit-preview coalescing", () => {
  it("shares one in-flight run and then serves TTL hits", async () => {
    let resolveFirst: (value: { status: string }) => void = () => undefined;
    const run = vi.fn(() => new Promise<{ status: string }>((resolve) => {
      resolveFirst = resolve;
    }));
    const first = coalesceExitPreview("pos1", undefined, true, run);
    const second = coalesceExitPreview("pos1", undefined, true, run);
    expect(run).toHaveBeenCalledOnce();
    resolveFirst({ status: "ok" });
    await expect(Promise.all([first, second])).resolves.toEqual([{ status: "ok" }, { status: "ok" }]);
    await expect(coalesceExitPreview("pos1", undefined, true, run)).resolves.toEqual({ status: "ok" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not share across position or convertRent keys", async () => {
    const run = vi.fn(async () => ({ n: run.mock.calls.length }));
    await coalesceExitPreview("a", undefined, true, run);
    await coalesceExitPreview("b", undefined, true, run);
    await coalesceExitPreview("a", undefined, false, run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(exitPreviewCacheKey("a", undefined, true)).not.toBe(exitPreviewCacheKey("a", undefined, false));
  });

  it("refetches after the preview TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
    const run = vi.fn(async () => ({ at: Date.now() }));
    await coalesceExitPreview("pos", undefined, true, run);
    vi.advanceTimersByTime(EXIT_PREVIEW_TTL_MS - 1);
    await coalesceExitPreview("pos", undefined, true, run);
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2);
    await coalesceExitPreview("pos", undefined, true, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not cache a thrown preview", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ status: "ok" });
    await expect(coalesceExitPreview("pos", undefined, true, run)).rejects.toThrow(/429/);
    await expect(coalesceExitPreview("pos", undefined, true, run)).resolves.toEqual({ status: "ok" });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
