import { afterEach, expect, it, vi } from "vitest";
import { exitRpcFetch } from "./lp-exit-rpc";

afterEach(() => vi.useRealTimers());

it("honors Retry-After and also retries JSON-RPC 429 inside HTTP 200", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: { code: 429 } }, { headers: { "Retry-After": "3" } }))
    .mockResolvedValueOnce(Response.json({ result: "ok" }));
  const pending = exitRpcFetch(fetcher, new AbortController().signal)("https://rpc.example");
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await (await pending).json()).toEqual({ result: "ok" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("cancels during backoff without making another request", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
  const pending = exitRpcFetch(fetcher, controller.signal)("https://rpc.example").catch(e => e);
  await vi.advanceTimersByTimeAsync(500);
  controller.abort();
  expect((await pending).name).toBe("AbortError");
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  [403, null], [429, "30"], [429, new Date(Date.now() + 60000).toUTCString()],
])("stops on HTTP %s with cooldown %s", async (status, retryAfter) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
    status, headers: retryAfter ? { "Retry-After": retryAfter } : {},
  }));
  expect((await exitRpcFetch(fetcher, new AbortController().signal)("https://rpc.example")).status).toBe(status);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
