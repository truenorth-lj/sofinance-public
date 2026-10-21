import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { opensDailyUnauthorizedStatus } from "./auth";

afterEach(() => vi.unstubAllEnvs());

describe("opens-daily bearer auth", () => {
  it("404s when the read token is unset or too short so the route stays undiscoverable", () => {
    vi.stubEnv("SOFINANCE_OPENS_READ_TOKEN", undefined);
    expect(opensDailyUnauthorizedStatus("Bearer anything")).toBe(404);
    vi.stubEnv("SOFINANCE_OPENS_READ_TOKEN", "short");
    expect(opensDailyUnauthorizedStatus("Bearer short")).toBe(404);
  });

  it("401s on a missing or wrong token using a constant-time compare", () => {
    const token = "a".repeat(32);
    vi.stubEnv("SOFINANCE_OPENS_READ_TOKEN", token);
    expect(opensDailyUnauthorizedStatus(null)).toBe(401);
    expect(opensDailyUnauthorizedStatus(`Bearer ${"b".repeat(32)}`)).toBe(401);
    expect(opensDailyUnauthorizedStatus(`Bearer ${token}`)).toBeNull();
  });
});
