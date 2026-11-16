import { expect, it, vi } from "vitest";
import { RHC_DEEP_LINK, unifiedAppRedirect } from "./deep-link";
// The proxy needs pure metadata; optional browser wallets and server registrations must stay outside its graph.
vi.mock("@/lib/dex/client", () => { throw new Error("Legacy redirects must not load the broad browser entry"); });
vi.mock("@/lib/dex/evm-client", () => { throw new Error("Legacy redirects must not load EVM wallet bindings"); });
vi.mock("@/lib/dex/modules", () => { throw new Error("Legacy redirects must not load server registrations"); });
it("resolves legacy redirects using only the pure metadata entry", () => {
  expect(unifiedAppRedirect("/app/rhc")).toBe(RHC_DEEP_LINK);
  expect(unifiedAppRedirect("/app")).toBe("/app/portfolio");
});
