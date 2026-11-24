import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { fakeSolanaAdapter, fakeSolanaDescriptor } from "./__contract__/testing/fake-dex";
import { createDexRegistry, type DexModule } from "./registry";

const accounts = { getMultipleAccountsInfo: vi.fn() } as unknown as Connection;
const input = (ids: string[]) => ({ wallet: "W", positions: ids.map((id) => ({ key: `meteora-dlmm:${id}` })) });

function registry(prefetch: DexModule["prefetchPortfolioAccounts"]) {
  const adapter = fakeSolanaAdapter();
  const performance = vi.spyOn(adapter, "performance");
  return { performance, registry: createDexRegistry([{ descriptor: fakeSolanaDescriptor, adapter: async () => adapter, prefetchPortfolioAccounts: prefetch }]) };
}

describe("generic Portfolio reader and the shared account batch", () => {
  it("warms the request batch with every position before rows read, and hands rows the same batch", async () => {
    const prefetch = vi.fn(async () => {});
    const { registry: dexes, performance } = registry(prefetch);
    const reader = await dexes.preparePortfolio("meteora-dlmm", input(["A", "B"]), new AbortController().signal, accounts);
    expect(prefetch).toHaveBeenCalledExactlyOnceWith(["A", "B"], accounts);
    const signal = new AbortController().signal;
    await reader!({ key: "meteora-dlmm:A" }, signal);
    expect(performance).toHaveBeenCalledWith("meteora-dlmm:A", { signal, accountReads: accounts });
  });
  it("still serves rows when the warm-up fails, and skips it without a shared batch", async () => {
    const prefetch = vi.fn(async () => { throw new Error("rpc down"); });
    const { registry: dexes, performance } = registry(prefetch);
    const reader = await dexes.preparePortfolio("meteora-dlmm", input(["A"]), new AbortController().signal, accounts);
    await expect(reader!({ key: "meteora-dlmm:A" }, new AbortController().signal)).resolves.toMatchObject({ historyComplete: true });
    prefetch.mockClear();
    const unshared = await dexes.preparePortfolio("meteora-dlmm", input(["A"]), new AbortController().signal);
    const signal = new AbortController().signal;
    await unshared!({ key: "meteora-dlmm:A" }, signal);
    expect(prefetch).not.toHaveBeenCalled(); expect(performance).toHaveBeenLastCalledWith("meteora-dlmm:A", { signal });
  });
});
