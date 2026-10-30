import { describe, expect, it } from "vitest";
import { unifiedPoolFlags } from "./flags";

describe("unifiedPoolFlags", () => {
  it("production shows Raydium + Robinhood Chain only (Orca and Meteora flags are off there)", () => {
    expect(unifiedPoolFlags("production")).toEqual({ orca: false, meteora: false, meteoraOpen: false, rhc: true, rhcSigning: true });
  });
  it("preview shows Meteora with its open flow", () => {
    expect(unifiedPoolFlags("preview")).toMatchObject({ meteora: true, meteoraOpen: true, rhc: true });
  });
});
