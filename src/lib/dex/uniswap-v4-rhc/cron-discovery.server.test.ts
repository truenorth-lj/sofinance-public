import { beforeEach, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { inspectRhcCronPools, readRhcCronIcons } from "./cron-discovery.server";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ discover: vi.fn(), findings: vi.fn(), capture: vi.fn(), client: vi.fn(), resolve: vi.fn(), sources: vi.fn() }));
vi.mock("@/lib/pool-metrics/rhc-discovery", () => ({ discoverRhcRegistryPools: backend.discover, rhcDiscoveryFindings: backend.findings }));
vi.mock("@/lib/sentry/capture", () => ({ captureRhcDiscoveryFindings: backend.capture }));
vi.mock("@/lib/rhc-range-apr", () => ({ rhcStateClient: backend.client }));
vi.mock("@/lib/token-icons/resolve", () => ({ resolveTokenIcons: backend.resolve, rhcCronIconSources: backend.sources }));
beforeEach(() => vi.resetAllMocks());
it("returns hidden inspection evidence and reports findings without creating a client when one is supplied", async () => {
  const client = {} as PublicClient, result = { pairs: 1 }, findings = ["hidden candidate"];
  backend.discover.mockResolvedValue(result); backend.findings.mockReturnValue(findings);
  expect(await inspectRhcCronPools(client)).toBe(result);
  expect(backend.discover).toHaveBeenCalledExactlyOnceWith(client);
  expect(backend.capture).toHaveBeenCalledExactlyOnceWith(findings);
  expect(backend.client).not.toHaveBeenCalled();
});
it("keeps discovery failures best effort but propagates default provider setup failures", async () => {
  const client = {} as PublicClient;
  backend.client.mockReturnValue(client); backend.discover.mockRejectedValue(new Error("RPC unavailable"));
  expect(await inspectRhcCronPools()).toEqual({ error: "RPC unavailable" });
  expect(backend.discover).toHaveBeenCalledExactlyOnceWith(client);
  expect(backend.capture).not.toHaveBeenCalled();
  const failure = new Error("provider setup failed"); backend.client.mockImplementation(() => { throw failure; });
  await expect(inspectRhcCronPools()).rejects.toBe(failure);
});
it("reads only approved RHC icon addresses with the original no-manual policy", async () => {
  const fetcher = vi.fn<typeof fetch>(), signal = new AbortController().signal, sources: unknown[] = [], rows: unknown[] = [];
  backend.sources.mockReturnValue(sources); backend.resolve.mockResolvedValue(rows);
  expect(await readRhcCronIcons({ mints: ["unapproved"], fetcher, signal })).toBe(rows);
  expect(backend.sources).toHaveBeenCalledExactlyOnceWith(fetcher);
  expect(backend.resolve).toHaveBeenCalledExactlyOnceWith("robinhood", UNIV4_RHC_ALLOWLISTED_POOLS.flatMap(pool => [pool.currency0.address, pool.currency1.address]), sources, { signal, manual: [] });
});
