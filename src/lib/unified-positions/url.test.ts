import { describe, expect, it } from "vitest";
import { initialSelectionFromQuery } from "./url";

describe("initialSelectionFromQuery (/app URL state)", () => {
  it("?position= picks a Solana position by key", () => {
    expect(initialSelectionFromQuery({ position: "raydium-clmm:Mint111", view: "withdraw" }))
      .toEqual({ initialView: "withdraw", initialMint: "Mint111", initialPositionKey: "" });
  });
  it("?position= picks a Robinhood Chain position by key", () => {
    expect(initialSelectionFromQuery({ position: "rhc-uniswap-v4:4077059", view: "compound" }))
      .toEqual({ initialView: "compound", initialMint: "", initialPositionKey: "rhc-uniswap-v4:4077059" });
  });
  it("old ?mint= and ?positionMint= links still work (back-compat)", () => {
    expect(initialSelectionFromQuery({ mint: "OldMint", view: "performance" })).toEqual({ initialView: "performance", initialMint: "OldMint", initialPositionKey: "" });
    expect(initialSelectionFromQuery({ positionMint: "OldMint2" }).initialMint).toBe("OldMint2");
    expect(initialSelectionFromQuery({ mint: ["A", "B"] }).initialMint).toBe("A");
  });
  it("a valid ?position= wins over ?mint=; an invalid one falls back to it", () => {
    expect(initialSelectionFromQuery({ position: "rhc-uniswap-v4:1", mint: "M" }).initialMint).toBe("");
    expect(initialSelectionFromQuery({ position: "nope:1", mint: "M" })).toEqual({ initialView: "compound", initialMint: "M", initialPositionKey: "" });
  });
  it("unknown views fall back to Compound", () => {
    expect(initialSelectionFromQuery({ view: "rhc" }).initialView).toBe("compound");
  });
});
