import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

const request = (init: Record<string, string>) => new Request("https://example.test/api", { headers: init });
const CLOUDFLARE = { SOFINANCE_TRUST_CLOUDFLARE_HEADERS: "true" };

describe("clientIp", () => {
  it("keeps the previous order without Cloudflare trust: x-real-ip, first x-forwarded-for, unknown", () => {
    expect(clientIp(request({ "x-real-ip": " 203.0.113.7 ", "x-forwarded-for": "198.51.100.1" }), {})).toBe("203.0.113.7");
    expect(clientIp(request({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" }), {})).toBe("198.51.100.1");
    expect(clientIp(request({ "x-real-ip": " ", "x-forwarded-for": "198.51.100.2" }), {})).toBe("198.51.100.2");
    expect(clientIp(request({}), {})).toBe("unknown");
  });

  it("ignores CF-Connecting-IP unless Cloudflare headers are trusted", () => {
    const headers = { "cf-connecting-ip": "192.0.2.9", "x-real-ip": "203.0.113.7" };
    expect(clientIp(request(headers), {})).toBe("203.0.113.7");
    expect(clientIp(request(headers), CLOUDFLARE)).toBe("192.0.2.9");
    expect(clientIp(request({ "x-real-ip": "203.0.113.7" }), CLOUDFLARE)).toBe("203.0.113.7");
  });
});
