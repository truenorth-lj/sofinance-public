import { describe, expect, it } from "vitest";
import {
  HALO_BAND_PX, HALO_MAX_DPR, HALO_PALETTE, haloBandWeight, haloCanvasScale, haloVisibleSlice, haloEase, haloGlintAlpha, haloProgress, haloRadius, haloReach,
  haloReducedStrength, haloRingAlpha, haloStrength, parseOpaqueRgb, schemeForBackground, shouldPlayHalo,
} from "./math";

describe("halo timing", () => {
  it("normalises elapsed time over the play and clamps it", () => {
    expect(haloProgress(0, 1000)).toBe(0);
    expect(haloProgress(250, 1000)).toBe(0.25);
    expect(haloProgress(1500, 1000)).toBe(1);
    expect(haloProgress(-5, 1000)).toBe(0);
    expect(haloProgress(300, 600)).toBe(0.5);
  });
  it("eases the radius with (1 − 2^(−9t)) / (1 − 2^(−9))", () => {
    expect(haloEase(0)).toBe(0);
    expect(haloEase(1)).toBeCloseTo(1, 12);
    expect(haloEase(0.1)).toBeCloseTo((1 - 2 ** -0.9) / (1 - 2 ** -9), 12);
    expect(haloEase(0.5)).toBeCloseTo((1 - 2 ** -4.5) / (1 - 2 ** -9), 12);
    // Fast start, slow finish.
    expect(haloEase(0.25)).toBeGreaterThan(0.75);
    for (let t = 0; t < 1; t += 0.05) expect(haloEase(t + 0.05)).toBeGreaterThan(haloEase(t));
  });
  it("strength = min(1, t/0.03) × (1 − t^2.2)", () => {
    expect(haloStrength(0)).toBe(0);
    expect(haloStrength(0.015)).toBeCloseTo(0.5 * (1 - 0.015 ** 2.2), 12);
    expect(haloStrength(0.03)).toBeCloseTo(1 - 0.03 ** 2.2, 12);
    expect(haloStrength(0.5)).toBeCloseTo(1 - 0.5 ** 2.2, 12);
    expect(haloStrength(1)).toBe(0);
    expect(haloStrength(2)).toBe(0);
  });
  it("reduced motion fades in and out in place at half strength", () => {
    expect(haloReducedStrength(0)).toBe(0);
    expect(haloReducedStrength(0.5)).toBeCloseTo(0.5, 12);
    expect(haloReducedStrength(1)).toBeCloseTo(0, 12);
    expect(haloReducedStrength(0.25)).toBeCloseTo(haloReducedStrength(0.75), 12);
  });
});

describe("halo geometry", () => {
  it("reaches just past the farthest corner of the surface", () => {
    expect(haloReach({ x: 0, y: 0 }, { width: 300, height: 400 })).toBeCloseTo(500 + HALO_BAND_PX / 2, 9);
    expect(haloReach({ x: 250, y: 100 }, { width: 300, height: 400 })).toBeCloseTo(Math.hypot(250, 300) + 55, 9);
    expect(haloRadius(0, 800)).toBe(0);
    expect(haloRadius(1, 800)).toBeCloseTo(800, 9);
  });
  it("weights a 110 px band around the front with (1 − x²)²", () => {
    expect(HALO_BAND_PX).toBe(110);
    expect(haloBandWeight(200, 200)).toBe(1);
    expect(haloBandWeight(200 + 27.5, 200)).toBeCloseTo((1 - 0.25) ** 2, 12);
    expect(haloBandWeight(200 + 55, 200)).toBe(0);
    expect(haloBandWeight(200 - 80, 200)).toBe(0);
  });
});

describe("halo colour by scheme", () => {
  it("uses the frost palettes", () => {
    expect(HALO_PALETTE.dark).toEqual([[80, 220, 175], [70, 195, 225], [180, 240, 150], [235, 255, 245]]);
    expect(HALO_PALETTE.light).toEqual([[40, 190, 150], [50, 170, 210], [140, 210, 90], [180, 235, 215]]);
  });
  it("tints at alpha × 0.24 in light mode and adds full light in dark mode", () => {
    expect(haloRingAlpha(1, "light")).toBeCloseTo(0.24, 12);
    expect(haloRingAlpha(0.5, "light")).toBeCloseTo(0.12, 12);
    expect(haloRingAlpha(0.5, "dark")).toBe(0.5);
  });
  it("glints at 0.3 (light) / 0.14 (dark), never under reduced motion", () => {
    expect(haloGlintAlpha(1, "light", false)).toBeCloseTo(0.3, 12);
    expect(haloGlintAlpha(1, "dark", false)).toBeCloseTo(0.14, 12);
    expect(haloGlintAlpha(0.5, "dark", false)).toBeCloseTo(0.07, 12);
    expect(haloGlintAlpha(1, "light", true)).toBe(0);
  });
  it("picks light or dark from the page background", () => {
    expect(schemeForBackground([11, 11, 11])).toBe("dark");
    expect(schemeForBackground([244, 240, 230])).toBe("light");
    expect(parseOpaqueRgb("rgb(11, 11, 11)")).toEqual([11, 11, 11]);
    expect(parseOpaqueRgb("rgba(244, 240, 230, 0.9)")).toEqual([244, 240, 230]);
    expect(parseOpaqueRgb("rgba(0, 0, 0, 0)")).toBeNull();
    expect(parseOpaqueRgb("rgb(1 2 3 / 20%)")).toBeNull();
    expect(parseOpaqueRgb("transparent")).toBeNull();
  });
});

describe("halo trigger", () => {
  it("plays once per confirmed signature, never while submitting or confirming", () => {
    expect(shouldPlayHalo(null, null)).toBe(false);
    expect(shouldPlayHalo({ phase: "submitting", signature: "" }, null)).toBe(false);
    expect(shouldPlayHalo({ phase: "confirming", signature: "sig1" }, null)).toBe(false);
    expect(shouldPlayHalo({ phase: "failed", signature: "sig1" }, null)).toBe(false);
    expect(shouldPlayHalo({ phase: "success", signature: "sig1" }, null)).toBe(true);
    expect(shouldPlayHalo({ phase: "success", signature: "sig1" }, "sig1")).toBe(false);
    expect(shouldPlayHalo({ phase: "success", signature: "sig2" }, "sig1")).toBe(true);
  });
});

describe("halo canvas size", () => {
  it("caps the device pixel ratio at 2", () => {
    expect(HALO_MAX_DPR).toBe(2);
    expect(haloCanvasScale(1)).toBe(1);
    expect(haloCanvasScale(1.5)).toBe(1.5);
    expect(haloCanvasScale(2)).toBe(2);
    expect(haloCanvasScale(3)).toBe(2);
    expect(haloCanvasScale(undefined)).toBe(1);
    expect(haloCanvasScale(0)).toBe(1);
  });
  it("covers only the visible slice of the content area (content area ∩ viewport)", () => {
    // A 2400 px tall content area scrolled 700 px down in a 900 px viewport, below a 60 px nav at the top of the page.
    expect(haloVisibleSlice({ left: 20, top: -700, width: 1240, height: 2400 }, { width: 1280, height: 900 }))
      .toEqual({ x: 0, y: 700, width: 1240, height: 900 });
    // Not scrolled: the slice starts at the content area's top and stops at the viewport bottom.
    expect(haloVisibleSlice({ left: 12, top: 80, width: 351, height: 3000 }, { width: 375, height: 812 }))
      .toEqual({ x: 0, y: 0, width: 351, height: 732 });
    expect(haloVisibleSlice({ left: 0, top: 1000, width: 100, height: 100 }, { width: 375, height: 812 }).height).toBe(0);
  });
  it("measures the reach to the far corner of the visible slice, not the whole content area", () => {
    const slice = haloVisibleSlice({ left: 20, top: -700, width: 1240, height: 2400 }, { width: 1280, height: 900 });
    const origin = { x: 120, y: 450 }; // the Compound button, in slice coordinates
    expect(haloReach(origin, slice)).toBeCloseTo(Math.hypot(1240 - 120, 450) + HALO_BAND_PX / 2, 9);
    expect(haloReach(origin, slice)).toBeLessThan(haloReach({ x: 120, y: 1150 }, { width: 1240, height: 2400 }));
  });
});
