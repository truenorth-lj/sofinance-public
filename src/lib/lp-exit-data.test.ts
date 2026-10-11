import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readFullExitPreview } from "./lp-exit-data";

const position = "So11111111111111111111111111111111111111112";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("uses the configured RPC and retries a limited RPC call before continuing", async () => {
  vi.useFakeTimers();
  vi.stubEnv("SOLANA_RPC_URL", "https://dedicated.example/rpc");
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: { code: 429 } }, { status: 429 }))
    .mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { context: { slot: 1 }, value: null } });
    });
  const result = readFullExitPreview(position, undefined, false, fetcher).catch(e => e);
  await vi.runAllTimersAsync();
  expect((await result).message).toBe("PersonalPositionState account invalid");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url]) => String(url) === "https://dedicated.example/rpc")).toBe(true);
});

it("stops after three attempts when the RPC keeps returning 429", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({ error: { code: 429, message: "Too many requests for a specific RPC call" } }, { status: 429 }));
  const result = readFullExitPreview(position, undefined, false, fetcher).catch(e => e);
  await vi.runAllTimersAsync();
  expect((await result).message).toMatch(/429/);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
