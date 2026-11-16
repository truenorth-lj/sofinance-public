import { expect, it, vi } from "vitest";
import { prepareNativeAprRun, type NativeAprRunInput } from "./index";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ enabled: false, loaded: false }));
vi.mock("@/lib/protocol-flags", async original => ({ ...await original<typeof import("@/lib/protocol-flags")>(), isRhcApr7dEnabled: () => state.enabled }));
vi.mock("@/lib/dex/uniswap-v4-rhc/prepare-apr.server", () => {
  state.loaded = true;
  return { prepareNativeRhcAprRun: async () => ({ pools: [], issues: [], stats: {} }) };
});
it("does not load native preparation for a disabled lane or unknown id", async () => {
  expect(state.loaded).toBe(false);
  for (const id of ["uniswap-v4-rhc", "unknown"]) expect(await prepareNativeAprRun(id, {} as NativeAprRunInput)).toBeNull();
  expect(state.loaded).toBe(false);
  state.enabled = true;
  await prepareNativeAprRun("uniswap-v4-rhc", { lease: { job: "rwa-apr-refresh", owner: "test", epoch: 1 } } as NativeAprRunInput);
  expect(state.loaded).toBe(true);
});
