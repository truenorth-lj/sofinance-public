import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath }));

const SECRET = "r".repeat(48);
const post = (authorization?: string) => new Request("http://127.0.0.1:8080/api/internal/revalidate", {
  method: "POST", headers: authorization ? { authorization } : {},
});

beforeEach(() => {
  revalidatePath.mockClear();
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("RAILWAY_PROJECT_ID", "railway-project");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/internal/revalidate", () => {
  it("revalidates exactly the warm-up paths on Railway with the CRON_SECRET bearer", async () => {
    const { POST } = await import("./route");
    const { ISR_WARMUP_PATHS } = await import("@/lib/isr-warmup");
    const response = POST(post(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ revalidated: [...ISR_WARMUP_PATHS] });
    expect(revalidatePath.mock.calls).toEqual(ISR_WARMUP_PATHS.map((path) => [path]));
  });

  it("is 404 off Railway (Vercel), even with the right bearer", async () => {
    vi.stubEnv("RAILWAY_PROJECT_ID", "");
    const { POST } = await import("./route");
    expect(POST(post(`Bearer ${SECRET}`)).status).toBe(404);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("is 401 without the right bearer", async () => {
    const { POST } = await import("./route");
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${SECRET}x`]) {
      expect(POST(post(authorization)).status).toBe(401);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
