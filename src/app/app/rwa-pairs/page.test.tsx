import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); } }));

describe("/app/rwa-pairs page (fallback for the proxy 307)", () => {
  it("redirects to the /app pool list, keeping the open-position deep link", async () => {
    const { default: Page } = await import("./page");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT /app#pools");
    await expect(Page({ searchParams: Promise.resolve({ pool: "P1", open: "1", ref: ["x", "y"] }) })).rejects.toThrow("NEXT_REDIRECT /app?openPool=P1&ref=x#pools");
  });
});
