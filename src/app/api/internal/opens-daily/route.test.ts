import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/opens-log/query", () => ({
  queryOpensDaily: vi.fn(async () => ({
    configured: true,
    days: [{
      date: "2026-10-19", opens: 2, uniqueWallets: 2, newUniqueWallets: 1, notionalUsd: 40,
      byRef: [{ ref: "x-launch", opens: 2, uniqueWallets: 2, newUniqueWallets: 1, notionalUsd: 40 }],
    }],
    range: { from: "2026-07-22T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" },
  })),
  opensDailyCsv: (days: Array<{ date: string }>) => `type,date\nday,${days[0]?.date}\n`,
}));

import { queryOpensDaily } from "@/lib/opens-log/query";
import { GET } from "./route";

const token = "c".repeat(32);

beforeEach(() => {
  vi.stubEnv("SOFINANCE_OPENS_READ_TOKEN", token);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/internal/opens-daily", () => {
  it("returns 404 when the read token is unset", async () => {
    vi.stubEnv("SOFINANCE_OPENS_READ_TOKEN", undefined);
    const response = await GET(new Request("http://localhost/api/internal/opens-daily"));
    expect(response.status).toBe(404);
    expect(queryOpensDaily).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong bearer token", async () => {
    const response = await GET(new Request("http://localhost/api/internal/opens-daily", {
      headers: { Authorization: `Bearer ${"d".repeat(32)}` },
    }));
    expect(response.status).toBe(401);
    expect(queryOpensDaily).not.toHaveBeenCalled();
  });

  it("returns daily JSON without a fee wallet when authorized", async () => {
    const response = await GET(new Request("http://localhost/api/internal/opens-daily?days=30", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const json = await response.json() as { days: unknown[] };
    expect(json.days).toHaveLength(1);
    expect(JSON.stringify(json)).not.toMatch(/feeWallet|SOFINANCE_FEE/);
    expect(queryOpensDaily).toHaveBeenCalledWith({ days: 30 });
  });

  it("returns CSV when format=csv", async () => {
    const response = await GET(new Request("http://localhost/api/internal/opens-daily?format=csv", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(await response.text()).toContain("day,2026-10-19");
  });
});
