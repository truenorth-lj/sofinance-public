import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PoolDailyAprResult } from "@/lib/pool-daily-apr";
import { createDexRegistry } from "../registry";
import { meteoraPoolDailyApr } from "./daily-apr.server";
import { meteoraDlmmDescriptor } from "./descriptor";

const series = { poolId: "P" } as PoolDailyAprResult;
const listed = async (poolId: string) => (poolId === "P" ? { poolId, mints: ["A", "B"] as const, binStep: null, source: "rwa-feed" as const } : null);

describe("meteoraPoolDailyApr", () => {
  it("serves only pools SoFinance lists", async () => {
    const load = vi.fn(async () => series);
    expect(await meteoraPoolDailyApr("P", { listedPool: listed, load })).toBe(series);
    expect(await meteoraPoolDailyApr("Q", { listedPool: listed, load })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("an unreadable pool list is UPSTREAM, never null (null would mean \"not Meteora's\")", async () => {
    const load = vi.fn(async () => series);
    await expect(meteoraPoolDailyApr("P", { listedPool: async () => { throw new Error("store down"); }, load }))
      .rejects.toMatchObject({ code: "UPSTREAM", message: expect.stringMatching(/Meteora pool list could not be read/) });
    expect(load).not.toHaveBeenCalled();
  });
  it("loader errors reach the caller as UPSTREAM with the cause", async () => {
    await expect(meteoraPoolDailyApr("P", { listedPool: listed, load: async () => { throw new Error("Meteora datapi did not answer"); } }))
      .rejects.toMatchObject({ code: "UPSTREAM", message: "Meteora datapi did not answer" });
  });
});

describe("dexRegistry.poolDailyApr", () => {
  it("asks registered modules in order and returns the first series; null when none lists the pool", async () => {
    const registry = createDexRegistry([{ descriptor: meteoraDlmmDescriptor, poolDailyApr: async (id) => (id === "P" ? series : null) }]);
    expect(await registry.poolDailyApr("P")).toBe(series);
    expect(await registry.poolDailyApr("Q")).toBeNull();
    expect(await createDexRegistry([{ descriptor: meteoraDlmmDescriptor }]).poolDailyApr("P")).toBeNull();
  });
  it("a module that cannot tell rethrows only when no other module answers", async () => {
    const down = { descriptor: meteoraDlmmDescriptor, poolDailyApr: async () => { throw new Error("list down"); } };
    const other = { descriptor: { ...meteoraDlmmDescriptor, id: "other-dex" as typeof meteoraDlmmDescriptor.id, aliases: [] },
      poolDailyApr: async (id: string) => (id === "P" ? series : null) };
    const registry = createDexRegistry([down, other]);
    expect(await registry.poolDailyApr("P")).toBe(series);
    await expect(registry.poolDailyApr("Q")).rejects.toThrow("list down");
  });
});
