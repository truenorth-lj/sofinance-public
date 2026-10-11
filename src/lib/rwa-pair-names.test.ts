import { describe, expect, it } from "vitest";
import { pairIssuerLabel } from "./rwa-pair-names";

describe("pairIssuerLabel", () => {
  it("names the company once and keeps only each side's issuer, in pool order", () => {
    expect(pairIssuerLabel("Robinhood xStock", "Robinhood Markets - Backpack Securities")).toBe("Robinhood xStock / Backpack");
    expect(pairIssuerLabel("SpaceX - Backpack Securities", "SpaceX xStock")).toBe("SpaceX Backpack / xStock");
    expect(pairIssuerLabel("Intel xStock", "Intel - Backpack Securities")).toBe("Intel xStock / Backpack");
    expect(pairIssuerLabel("Strategy - Backpack Securities", "MicroStrategy xStock")).toBe("Strategy Backpack / xStock");
  });

  it("keeps an issuer that is not suffixed with Securities", () => {
    expect(pairIssuerLabel("NVIDIA xStock", "NVIDIA - Ondo")).toBe("NVIDIA xStock / Ondo");
  });

  it("falls back to the full names when either side has an unknown shape", () => {
    expect(pairIssuerLabel("Robinhood xStock", "Robinhood Markets")).toBe("Robinhood xStock / Robinhood Markets");
    expect(pairIssuerLabel("A", "B")).toBe("A / B");
  });
});
