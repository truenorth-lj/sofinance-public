import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/open-state", () => ({ readOpenPoolState: vi.fn() }));

import { QUOTE_TTL_MS } from "@sofinance/engine/ids";
import { readOpenPoolState, type OpenPoolState } from "@sofinance/engine/open-state";
import { cachedOpenPoolState, clearOpenPoolSnapshots } from "./open-pool-snapshot";

const selection = { poolId: "pool", inputMint: "mint", inputKind: "token" as const };

beforeEach(() => {
  clearOpenPoolSnapshots();
  vi.mocked(readOpenPoolState).mockReset();
});

describe("cachedOpenPoolState", () => {
  it("reuses one RPC snapshot across relay rounds of the same preview", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue({ fetchedAt: Date.now(), poolId: "pool" } as OpenPoolState);
    const first = await cachedOpenPoolState("wallet", selection);
    const second = await cachedOpenPoolState("wallet", selection);
    expect(first).toBe(second);
    expect(readOpenPoolState).toHaveBeenCalledOnce();
  });

  it("does not share snapshots across wallets or pools", async () => {
    vi.mocked(readOpenPoolState).mockImplementation(async (wallet, next) =>
      ({ fetchedAt: Date.now(), wallet, poolId: next.poolId } as OpenPoolState));
    await cachedOpenPoolState("a", selection);
    await cachedOpenPoolState("b", selection);
    await cachedOpenPoolState("a", { ...selection, poolId: "other" });
    expect(readOpenPoolState).toHaveBeenCalledTimes(3);
  });

  it("refetches after the engine snapshot TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.mocked(readOpenPoolState).mockResolvedValue({ fetchedAt: 1_000_000 } as OpenPoolState);
    await cachedOpenPoolState("wallet", selection);
    vi.setSystemTime(1_000_000 + QUOTE_TTL_MS + 1);
    vi.mocked(readOpenPoolState).mockResolvedValue({ fetchedAt: 1_000_000 + QUOTE_TTL_MS + 1 } as OpenPoolState);
    await cachedOpenPoolState("wallet", selection);
    expect(readOpenPoolState).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
