import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { zeroFeeAllowed } from "./fee-wallet.server";

describe("zeroFeeAllowed", () => {
  it("allows a 0 fee only in unit tests and local development", () => {
    expect(zeroFeeAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(zeroFeeAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(zeroFeeAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(zeroFeeAllowed({ NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false);
    expect(zeroFeeAllowed({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(false);
    expect(zeroFeeAllowed({ NODE_ENV: "test", VERCEL_ENV: "production" })).toBe(false);
    expect(zeroFeeAllowed({})).toBe(false);
  });
});
