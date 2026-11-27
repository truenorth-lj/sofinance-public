import { describe, expect, it } from "vitest";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("answers 200 ok, uncached, without touching any dependency", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) expect(response.headers.get(name)).toBe(value);
  });
});
