import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { RHC_DEEP_LINK, unifiedAppRedirect } from "./deep-link";

afterEach(() => { vi.unstubAllEnvs(); });

describe("/app/rhc → /app deep link", () => {
  it("points at the allowlisted Robinhood Chain pool", () => {
    expect(RHC_DEEP_LINK).toBe("/app?openPool=0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c");
    expect(unifiedAppRedirect("/app/rhc")).toBe(RHC_DEEP_LINK);
    expect(unifiedAppRedirect("/app")).toBeNull();
  });
  it("is a real 307 from the proxy in production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = proxy(new NextRequest("https://sofinancelab.xyz/app/rhc", { headers: { host: "sofinancelab.xyz" } }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe(RHC_DEEP_LINK);
  });
});
