import { describe, expect, it } from "vitest";
import { initialSelectionFromQuery } from "./url";

describe("initialSelectionFromQuery (/app URL state)", () => {
  it("?position= passes any valid key through unchanged (no source is special-cased here)", () => {
    expect(initialSelectionFromQuery({ position: "raydium-clmm:Mint111", view: "withdraw" }))
      .toEqual({ initialView: "withdraw", initialMint: "", initialPositionKey: "raydium-clmm:Mint111" });
  });
  it("?position= picks a Robinhood Chain or Meteora position by key", () => {
    expect(initialSelectionFromQuery({ position: "meteora-dlmm:Pos111" }).initialPositionKey).toBe("meteora-dlmm:Pos111");
    expect(initialSelectionFromQuery({ position: "rhc-uniswap-v4:4077059", view: "compound" }))
      .toEqual({ initialView: "compound", initialMint: "", initialPositionKey: "rhc-uniswap-v4:4077059" });
    expect(initialSelectionFromQuery({ position: "uniswap-v4-rhc:4077059", view: "compound" }))
      .toEqual({ initialView: "compound", initialMint: "", initialPositionKey: "uniswap-v4-rhc:4077059" });
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
