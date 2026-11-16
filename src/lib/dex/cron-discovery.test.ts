import { beforeEach, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { inspectCronPools, readCronTokenIcons, type CronIconInput } from "./index";
import { createDexRegistry } from "./registry";
import { raydiumClmmModule } from "./raydium-clmm/module";
import { uniswapV4RhcModule } from "./uniswap-v4-rhc/module";
import { DexUnsupportedError } from "./errors";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ raydiumLoaded: false, rhcLoaded: false, raydium: vi.fn(), rhc: vi.fn(), inspect: vi.fn() }));
vi.mock("@/lib/dex/raydium-clmm/cron-icons.server", () => {
  backend.raydiumLoaded = true; return { readRaydiumCronIcons: backend.raydium };
});
vi.mock("@/lib/dex/uniswap-v4-rhc/cron-discovery.server", () => {
  backend.rhcLoaded = true; return { readRhcCronIcons: backend.rhc, inspectRhcCronPools: backend.inspect };
});
beforeEach(() => vi.resetAllMocks());
it("keeps native icon and inspection implementations unloaded for metadata and unbound requests", async () => {
  expect([backend.raydiumLoaded, backend.rhcLoaded]).toEqual([false, false]);
  for (const id of ["unknown", "meteora-dlmm", "orca-whirlpool", "rhc-uniswap-v4"]) {
    await expect(readCronTokenIcons(id, {} as CronIconInput)).rejects.toBeInstanceOf(DexUnsupportedError);
    await expect(inspectCronPools(id)).rejects.toBeInstanceOf(DexUnsupportedError);
  }
  await expect(inspectCronPools("raydium-clmm")).rejects.toBeInstanceOf(DexUnsupportedError);
  expect([backend.raydiumLoaded, backend.rhcLoaded]).toEqual([false, false]);
});
it("captures icon mints and provider references before lazy loading", async () => {
  const input = { mints: ["original"], fetcher: vi.fn<typeof fetch>(), signal: new AbortController().signal };
  const original = { ...input, mints: [...input.mints] }, result: unknown[] = [];
  backend.raydium.mockResolvedValue(result);
  const pending = readCronTokenIcons("raydium-clmm", input);
  input.mints[0] = "changed"; input.mints.push("added"); input.fetcher = vi.fn<typeof fetch>(); input.signal = new AbortController().signal;
  expect(await pending).toBe(result);
  expect(backend.raydium).toHaveBeenCalledExactlyOnceWith(original);
  const captured = backend.raydium.mock.calls[0]![0] as CronIconInput;
  expect(captured.fetcher).toBe(original.fetcher); expect(captured.signal).toBe(original.signal);
  expect(backend.rhcLoaded).toBe(false);
});
it("preserves the explicit inspection client and the default-client request", async () => {
  const client = {} as PublicClient, result = { pairs: 1 };
  backend.inspect.mockResolvedValue(result);
  expect(await inspectCronPools("uniswap-v4-rhc", client)).toBe(result);
  expect(backend.inspect).toHaveBeenLastCalledWith(client);
  expect(backend.inspect.mock.calls[0]![0]).toBe(client);
  await inspectCronPools("uniswap-v4-rhc");
  expect(backend.inspect).toHaveBeenLastCalledWith(undefined);
});
it("keeps existing cron reads independent of generic HTTP flags and propagates native failures", async () => {
  const registry = createDexRegistry([{ ...raydiumClmmModule, enabled: () => false }, { ...uniswapV4RhcModule, enabled: () => false }]);
  expect(registry.isDisabled("raydium-clmm", "open")).toBe(true);
  expect(registry.isDisabled("uniswap-v4-rhc", "positions")).toBe(true);
  const input = { mints: [], fetcher: undefined, signal: new AbortController().signal };
  backend.rhc.mockResolvedValue([]); backend.inspect.mockResolvedValue({ error: "inspection unavailable" });
  expect(await registry.readCronTokenIcons("uniswap-v4-rhc", input)).toEqual([]);
  expect(await registry.inspectCronPools("uniswap-v4-rhc")).toEqual({ error: "inspection unavailable" });
  const failure = new Error("provider setup failed");
  backend.inspect.mockRejectedValue(failure); backend.raydium.mockRejectedValue(failure);
  await expect(registry.inspectCronPools("uniswap-v4-rhc")).rejects.toBe(failure);
  await expect(registry.readCronTokenIcons("raydium-clmm", input)).rejects.toBe(failure);
});
