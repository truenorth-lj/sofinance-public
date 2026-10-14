import { describe, expect, it } from "vitest";
import { validateRwaTarget } from "./target";

describe("dedicated RWA database target", () => {
  it("accepts the dedicated role and database with either PostgreSQL scheme", () => {
    expect(() => validateRwaTarget("postgres://sofinance:placeholder@localhost/sofinance")).not.toThrow();
    expect(() => validateRwaTarget("postgresql://sofinance:placeholder@localhost/sofinance")).not.toThrow();
  });
  it.each([
    "postgres://admin:placeholder@localhost/sofinance",
    "postgres://sofinance:placeholder@localhost/postgres",
    "https://sofinance:placeholder@localhost/sofinance",
    "invalid",
  ])("refuses an unintended target %s", (url) => {
    expect(() => validateRwaTarget(url)).toThrow("Use the dedicated sofinance database and role");
  });
});
