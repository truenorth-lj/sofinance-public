import { beforeEach, expect, it, vi } from "vitest";
import { refreshTokenIcons } from "./rwa-refresh";
import type { Lease, RwaStore } from "./rwa-store-types";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/dex", async load => ({ ...await load<typeof import("./dex")>(), readCronTokenIcons: backend.read }));
beforeEach(() => vi.resetAllMocks());
const lease = (): Lease => ({ job: "rwa-discovery", owner: "original", epoch: 1 });
it("preserves initiating lease and seeds across icon reads, then renews and saves in order", async () => {
  let release!: (rows: unknown[]) => void;
  backend.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce([{ address: "rhc" }]);
  const authority = lease(), original = { ...authority }, pairs = [{ mintA: "a", mintB: "b" }];
  const signal = new AbortController().signal, fetcher = vi.fn<typeof fetch>();
  const request = vi.fn().mockResolvedValue({ saved: 2 }), store = { request } as unknown as RwaStore;
  const pending = refreshTokenIcons(store, authority, pairs, fetcher, signal);
  authority.owner = "changed"; authority.epoch = 99; pairs[0]!.mintA = "changed";
  release([{ address: "solana" }]);
  expect(await pending).toEqual({ saved: 2 });
  const input = { mints: ["a", "b"], fetcher, signal };
  expect(backend.read).toHaveBeenNthCalledWith(1, "raydium-clmm", input);
  expect(backend.read).toHaveBeenNthCalledWith(2, "uniswap-v4-rhc", input);
  expect(request.mock.calls).toEqual([[{ op: "renew", lease: original }], [{ op: "saveTokenIcons", lease: original, data: [{ address: "solana" }, { address: "rhc" }] }]]);
});
it("writes nothing if cancellation arrives while icon reading is pending", async () => {
  let release!: (rows: unknown[]) => void;
  backend.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce([]);
  const controller = new AbortController(), request = vi.fn(), store = { request } as unknown as RwaStore;
  const pending = refreshTokenIcons(store, lease(), [], undefined, controller.signal);
  controller.abort(); release([]);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(request).not.toHaveBeenCalled();
});
it("preserves native read failures without renewing or saving a partial result", async () => {
  const failure = new Error("icon read failed"), request = vi.fn();
  backend.read.mockResolvedValueOnce([]).mockRejectedValueOnce(failure);
  await expect(refreshTokenIcons({ request } as unknown as RwaStore, lease(), [], undefined, new AbortController().signal)).rejects.toBe(failure);
  expect(request).not.toHaveBeenCalled();
});
