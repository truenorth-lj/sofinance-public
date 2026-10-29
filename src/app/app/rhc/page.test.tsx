import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/rhc-univ4-pool-view", () => ({ loadRhcPoolView: vi.fn(async () => null) }));

afterEach(() => { vi.unstubAllEnvs(); });

describe("/app/rhc page", () => {
  it("renders in production with signing on (launched 2026-10-29)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const { default: RhcPage } = await import("./page");
    const el = await RhcPage();
    const json = JSON.stringify(el, (_k, v) => (typeof v === "function" ? v.name : v));
    expect(json).toContain("\"signingEnabled\":true");
  });
  it("renders on preview with signing on (preview-only test signing)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: RhcPage } = await import("./page");
    const el = await RhcPage();
    const json = JSON.stringify(el, (_k, v) => (typeof v === "function" ? v.name : v));
    expect(json).toContain("\"signingEnabled\":true");
  });
});
