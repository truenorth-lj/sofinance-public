import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); },
}));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("/app/rhc page", () => {
  it.each(["production", "preview", "development"])("redirects to the RHC pool on the pools page (%s)", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    const { default: RhcPage } = await import("./page");
    expect(() => RhcPage()).toThrow("NEXT_REDIRECT /app/rwa-pairs?openPool=0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c");
  });
});
