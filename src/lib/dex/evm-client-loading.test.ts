import { expect, it, vi } from "vitest";
import { dexDescriptors } from "./client";
const loaded = vi.hoisted(() => ({ native: false }));
vi.mock("@/lib/dex/uniswap-v4-rhc/client-module", () => {
  loaded.native = true; throw new Error("Metadata must not load native wallet bindings");
});
it("keeps optional native wallet bindings out of metadata-only consumers", () => {
  expect(dexDescriptors.descriptorFor("uniswap-v4-rhc")?.ui?.openUi).toBe("rhc-dialog");
  expect(loaded.native).toBe(false);
});
