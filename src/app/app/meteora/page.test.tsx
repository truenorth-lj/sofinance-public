import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/meteora-open-view", () => ({ loadMeteoraOpenPoolView: vi.fn(async () => null) }));

afterEach(() => { vi.unstubAllEnvs(); });

describe("/app/meteora page", () => {
  it("is not found in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const { default: MeteoraPage } = await import("./page");
    await expect(MeteoraPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("renders on preview with signing on", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: MeteoraPage } = await import("./page");
    const json = JSON.stringify(await MeteoraPage(), (_k, v) => (typeof v === "function" ? v.name : v));
    expect(json).toContain("\"signingEnabled\":true");
  });
});
