import { describe, expect, it } from "vitest";
import { pickRulerStop, rulerFraction } from "./ruler";

const STOPS = [0.1, 1, 5, 10, 25, 50] as const;

describe("pickRulerStop", () => {
  it("hits the last stop at and past the right edge", () => {
    expect(pickRulerStop(200, 0, 200, STOPS)).toBe(50);
    expect(pickRulerStop(201, 0, 200, STOPS)).toBe(50);
    expect(pickRulerStop(400, 100, 200, STOPS)).toBe(50);
    expect(pickRulerStop(430, 100, 200, STOPS)).toBe(50);
  });

  it("hits the first stop at and before the left edge", () => {
    expect(pickRulerStop(0, 0, 200, STOPS)).toBe(0.1);
    expect(pickRulerStop(-4, 0, 200, STOPS)).toBe(0.1);
  });

  it("snaps to the nearest stop in the middle", () => {
    expect(pickRulerStop(100, 0, 200, STOPS)).toBe(10);
  });
});

describe("rulerFraction", () => {
  it("puts the last stop at 1", () => {
    expect(rulerFraction(STOPS, 50)).toBe(1);
    expect(rulerFraction(STOPS, 0.1)).toBe(0);
  });
});
