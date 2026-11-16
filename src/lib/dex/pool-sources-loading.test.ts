import { expect, it, vi } from "vitest";
import { dexRegistry } from "./index";
vi.mock("server-only", () => ({}));
const loaded = vi.hoisted(() => ({ raydium: false, meteora: false }));
vi.mock("@/lib/pool-sources/raydium", () => {
  loaded.raydium = true;
  return { raydiumPoolSource: { id: "raydium-clmm" } };
});
vi.mock("@/lib/pool-sources/meteora", () => {
  loaded.meteora = true;
  return { meteoraPoolSource: { id: "meteora-dlmm" } };
});

it("loads only the requested cron source, independently of generic HTTP enablement", async () => {
  expect(loaded).toEqual({ raydium: false, meteora: false });
  for (const id of ["unknown", "toString", "orca-whirlpool", "uniswap-v4-rhc", "rhc-uniswap-v4"]) {
    expect(await dexRegistry.poolSourceFor(id)).toBeNull();
  }
  expect(loaded).toEqual({ raydium: false, meteora: false });
  expect(dexRegistry.isDisabled("raydium-clmm", "open")).toBe(true);
  const raydium = await dexRegistry.poolSourceFor("raydium-clmm");
  expect(raydium?.id).toBe("raydium-clmm");
  expect(loaded).toEqual({ raydium: true, meteora: false });
  const sources = await dexRegistry.poolSources();
  expect(sources.map(source => source.id)).toEqual(["raydium-clmm", "meteora-dlmm"]);
  expect(loaded).toEqual({ raydium: true, meteora: true });
  expect(Object.isFrozen(sources)).toBe(true);
  expect(sources[0]).toBe(raydium);
  expect(sources[1]).toBe(await dexRegistry.poolSourceFor("meteora-dlmm"));
});
