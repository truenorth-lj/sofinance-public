import { beforeEach, describe, expect, it, vi } from "vitest";
import PositionPerformancePage from "./page";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn((url: string) => { throw new Error(`redirect: ${url}`); }) }));
vi.mock("next/navigation", () => ({ redirect }));

beforeEach(() => { redirect.mockClear(); });
describe("legacy performance route", () => {
  it("redirects to the Performance tab inside Positions", async () => {
    await expect(PositionPerformancePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect");
    expect(redirect).toHaveBeenCalledWith("/app?view=performance");
  });
  it("preserves mint, wallet and pool query parameters", async () => {
    await expect(PositionPerformancePage({ searchParams: Promise.resolve({ mint: "position-mint", wallet: "owner-wallet", pool: "pool-id", view: "deposit" }) })).rejects.toThrow("redirect");
    const destination = new URL(redirect.mock.calls[0]![0]!, "https://example.com");
    expect(destination.pathname).toBe("/app");
    expect(Object.fromEntries(destination.searchParams)).toEqual({ mint: "position-mint", wallet: "owner-wallet", pool: "pool-id", view: "performance" });
  });
  it("preserves repeated query parameters", async () => {
    await expect(PositionPerformancePage({ searchParams: Promise.resolve({ mint: ["first-mint", "second-mint"] }) })).rejects.toThrow("redirect");
    expect(new URL(redirect.mock.calls[0]![0]!, "https://example.com").searchParams.getAll("mint")).toEqual(["first-mint", "second-mint"]);
  });
});
