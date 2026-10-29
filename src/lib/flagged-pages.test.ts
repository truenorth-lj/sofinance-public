import { describe, expect, it } from "vitest";
import { isFlaggedOffPage } from "./flagged-pages";

describe("isFlaggedOffPage", () => {
  it("hides /app/rhc in production (RHC_UNIV4_TRADING_ENABLED off)", () => {
    for (const p of ["/app/rhc", "/app/rhc/", "/app/rhc/x"]) expect(isFlaggedOffPage(p, "production")).toBe(true);
  });
  it("shows it on preview and development", () => {
    expect(isFlaggedOffPage("/app/rhc", "preview")).toBe(false);
    expect(isFlaggedOffPage("/app/rhc", "development")).toBe(false);
  });
  it("leaves other pages alone", () => {
    for (const p of ["/", "/app", "/app/rhcx", "/app/rwa-pairs"]) expect(isFlaggedOffPage(p, "production")).toBe(false);
  });
});
