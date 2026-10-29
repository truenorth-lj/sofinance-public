import { describe, expect, it } from "vitest";
import { isFlaggedOffPage } from "./flagged-pages";

describe("isFlaggedOffPage", () => {
  it("shows /app/rhc in production, preview and development (RHC_UNIV4_TRADING_ENABLED on)", () => {
    for (const p of ["/app/rhc", "/app/rhc/", "/app/rhc/x"]) expect(isFlaggedOffPage(p, "production")).toBe(false);
    expect(isFlaggedOffPage("/app/rhc", "preview")).toBe(false);
    expect(isFlaggedOffPage("/app/rhc", "development")).toBe(false);
  });
  it("leaves other pages alone", () => {
    for (const p of ["/", "/app", "/app/rhcx", "/app/rwa-pairs"]) expect(isFlaggedOffPage(p, "production")).toBe(false);
  });
});
