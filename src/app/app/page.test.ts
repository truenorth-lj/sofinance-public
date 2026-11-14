import { afterEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`redirect:${url}`); }));
vi.mock("next/navigation", () => ({ redirect }));
import AppHome from "./page";

afterEach(() => redirect.mockClear());

describe("/app page fallback (requests that skip the proxy)", () => {
  it("redirects to Portfolio and keeps ?position= and the other params", async () => {
    await expect(AppHome({ searchParams: Promise.resolve({ position: "meteora-dlmm:Pos111", view: "withdraw" }) })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith("/app/portfolio?position=meteora-dlmm%3APos111&view=withdraw");
  });
  it("sends old ?openPool= links to the pools page", async () => {
    await expect(AppHome({ searchParams: Promise.resolve({ openPool: "poolone" }) })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith("/app/rwa-pairs?openPool=poolone");
  });
  it("redirects a bare /app to Portfolio", async () => {
    await expect(AppHome({ searchParams: Promise.resolve({}) })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith("/app/portfolio");
  });
});
