import { expect, it, vi } from "vitest";
import { POST } from "@/app/api/lp-decision/route";
import { GET } from "@/app/api/lp-decision/exit-preview/route";
vi.mock("server-only", () => ({}));
const loaded = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/dex/raydium-clmm/lp-observations.server", () => { loaded.push("observations"); throw new Error("Unexpected observations load"); });
vi.mock("@/lib/dex/raydium-clmm/lp-exit-preview.server", () => { loaded.push("preview"); throw new Error("Unexpected preview load"); });
it("keeps invalid, no-context and demo requests free of observational/build engine loading", async () => {
  const base = { requestId: "test", contextVersion: 1, amountAtomic: "1", asset: "USDC", decimals: 6, numeraire: "USDC",
    targetDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), demo: false };
  const request = (body: unknown) => new Request("https://example.test/api/lp-decision", { method: "POST", body: JSON.stringify(body) });
  expect((await POST(request({}))).status).toBe(400);
  const empty = await POST(request(base)); expect(empty.status).toBe(200); expect(await empty.json()).toMatchObject({ executable: false, status: "unavailable" });
  const demo = await POST(request({ ...base, demo: true, poolId: "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72" }));
  expect(demo.status).toBe(200); expect(await demo.json()).toMatchObject({ executable: false, status: "scenario" });
  expect((await GET(new Request("https://example.test/api/lp-decision/exit-preview?positionId=bad"))).status).toBe(400);
  expect(loaded).toEqual([]);
});
