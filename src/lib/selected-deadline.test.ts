import { afterEach, expect, it, vi } from "vitest";
import { SELECTED_DEADLINE_MS, withSelectedDeadline } from "./selected-deadline";

afterEach(() => vi.useRealTimers());
it("returns timing for completed work and leaves the signed broadcast outside this helper", async () => {
  const response = await withSelectedDeadline(new Request("http://localhost/quote"), async (signal) => {
    expect(signal.aborted).toBe(false); return Response.json({ quote: true });
  });
  expect(response.status).toBe(200); expect(response.headers.get("Server-Timing")).toMatch(/^total;dur=/);
});
it("propagates the eight-second cancellation to all fanout work and returns 504", async () => {
  vi.useFakeTimers();
  const aborted = vi.fn();
  const result = withSelectedDeadline(new Request("http://localhost/prepare"), async (signal) => {
    await Promise.all([1, 2].map(() => new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(signal.reason); }, { once: true });
    })));
    return Response.json({ unreachable: true });
  });
  await vi.advanceTimersByTimeAsync(SELECTED_DEADLINE_MS);
  const response = await result;
  expect(response.status).toBe(504); expect(aborted).toHaveBeenCalledTimes(2);
  expect(await response.json()).toEqual({ error: "Preparation took too long; please retry" });
});
it("client cancellation aborts preparation immediately", async () => {
  const client = new AbortController(); let received: AbortSignal | undefined;
  const result = withSelectedDeadline(new Request("http://localhost/quote", { signal: client.signal }), async (signal) => {
    received = signal; return new Promise<Response>(() => {});
  });
  client.abort(); const response = await result;
  expect(received?.aborted).toBe(true); expect(response.status).toBe(499);
});
