import { describe, expect, it } from "vitest";
import { NO_STORE_HEADERS } from "./no-store";

describe("NO_STORE_HEADERS", () => {
  it("sets Cache-Control: no-store on a response, alone or merged with other headers", () => {
    expect(Response.json({}, { headers: NO_STORE_HEADERS }).headers.get("Cache-Control")).toBe("no-store");
    const merged = Response.json({}, { headers: { ...NO_STORE_HEADERS, "Retry-After": "60" } });
    expect(merged.headers.get("Cache-Control")).toBe("no-store");
    expect(merged.headers.get("Retry-After")).toBe("60");
  });
});
