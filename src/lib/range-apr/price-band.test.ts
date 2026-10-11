import { describe, expect, it } from "vitest";
import { ticksFromUiPriceBand } from "../open-range";
import { parsePriceInput, ticksFromPriceBand } from "./price-band";
import { uiPriceFromTick } from "./tick-math";

describe("ticksFromPriceBand parity with the server's ticksFromUiPriceBand", () => {
  it("returns the same ticks for percent bands around prices at several tick spacings and decimals", () => {
    const cases: Array<[number, number, number]> = [[6, 6, 1], [6, 8, 1], [8, 6, 60], [6, 6, 10], [9, 6, 120]];
    for (const [decimalsA, decimalsB, spacing] of cases) {
      for (const centerTick of [-46_068, -3, 0, 7, 46_058]) {
        const center = uiPriceFromTick(centerTick + 0.37, decimalsA, decimalsB);
        for (const half of [0.0005, 0.003, 0.01, 0.025]) {
          const min = center * (1 - half);
          const max = center * (1 + half);
          expect(ticksFromPriceBand(min, max, decimalsA, decimalsB, spacing))
            .toEqual(ticksFromUiPriceBand(min, max, decimalsA, decimalsB, spacing));
        }
      }
    }
  });

  it("matches the server's collapse handling (at least one spacing apart)", () => {
    const server = ticksFromUiPriceBand(1.0000001, 1.0000002, 6, 6, 10);
    expect(ticksFromPriceBand(1.0000001, 1.0000002, 6, 6, 10)).toEqual(server);
    expect(server.tickUpper - server.tickLower).toBeGreaterThanOrEqual(10);
  });

  it("is null for an inverted or non-positive band", () => {
    expect(ticksFromPriceBand(1.1, 1, 6, 6, 1)).toBeNull();
    expect(ticksFromPriceBand(1, 1, 6, 6, 1)).toBeNull();
    expect(ticksFromPriceBand(0, 1, 6, 6, 1)).toBeNull();
    expect(ticksFromPriceBand(-1, 1, 6, 6, 1)).toBeNull();
  });
});

describe("parsePriceInput", () => {
  it("accepts strict positive decimals like the server parser", () => {
    expect(parsePriceInput("0.9974")).toBe(0.9974);
    expect(parsePriceInput("1")).toBe(1);
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("0")).toBeNull();
    expect(parsePriceInput("01")).toBeNull();
    expect(parsePriceInput("1e3")).toBeNull();
    expect(parsePriceInput("-1")).toBeNull();
    expect(parsePriceInput(".5")).toBeNull();
  });
});
