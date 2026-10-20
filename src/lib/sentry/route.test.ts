import { describe, expect, it } from "vitest";
import { applyRouteFromEvent, pathnameFromUrl, routeFromRequest, routeFromSentryEvent, routeFromTransaction } from "./route";

describe("request/Next route derivation", () => {
  it("uses the request pathname, not a bundled stack guess", () => {
    const request = new Request("https://sofinancelab.xyz/api/wallet?wallet=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(routeFromRequest(request)).toBe("/api/wallet");
    expect(pathnameFromUrl("https://stagish.example/api/rwa-pairs?minTvl=1")).toBe("/api/rwa-pairs");
    expect(routeFromTransaction("GET /api/wallet")).toBe("/api/wallet");
    expect(routeFromSentryEvent({
      transaction: "GET /api/rwa-pairs",
      request: { url: "https://sofinancelab.xyz/api/wallet?wallet=abc" },
    })).toBe("/api/wallet");
  });

  it("overwrites a wrong route tag from the request path", () => {
    const event = applyRouteFromEvent({
      tags: { route: "/api/rwa-pairs", error_class: "Error" },
      request: { url: "https://sofinancelab.xyz/api/wallet" },
    });
    expect(event.tags?.route).toBe("/api/wallet");
  });
});
