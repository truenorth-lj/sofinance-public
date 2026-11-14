import { describe, expect, it } from "vitest";
import {
  HALO_BAND_PX, HALO_DURATION_MS, HALO_EASE_K, HALO_MAX_DPR, HALO_PALETTE, HALO_PUNCH_T, HALO_PUNCH_TRAVEL, HALO_RISE_MAX_PX,
  HALO_RISE_MIN_PX, HALO_SHAKE_MS, HALO_SHAKE_PX, haloRiseCenter,
  HALO_TRAIL_DELAY, HALO_TRAIL_STRENGTH, haloBandWeight, haloCanvasScale, haloVisibleSlice, haloEase, haloGlintAlpha,
  haloOriginPoint, haloProgress, haloRadius, haloReach, haloReducedStrength, haloRingAlpha, haloShake, haloStrength,
  haloTrailStrength, haloTrailTime, nextHaloTrigger, parseOpaqueRgb, schemeForBackground, shouldPlayHalo,
} from "./math";

describe("halo timing", () => {
  it("normalises elapsed time over the play and clamps it", () => {
    expect(HALO_DURATION_MS).toBe(1200);
    expect(haloProgress(0, 1200)).toBe(0);
    expect(haloProgress(300, 1200)).toBe(0.25);
    expect(haloProgress(1500, 1200)).toBe(1);
    expect(haloProgress(-5, 1200)).toBe(0);
    expect(haloProgress(300, 600)).toBe(0.5);
  });
  it("eases the radius with a sharp launch, then a linear coast", () => {
    expect(haloEase(0)).toBe(0);
    expect(haloEase(1)).toBeCloseTo(1, 12);
    const punch = (u: number) => HALO_PUNCH_TRAVEL * (1 - 2 ** -(HALO_EASE_K * u)) / (1 - 2 ** -HALO_EASE_K);
    expect(haloEase(HALO_PUNCH_T / 2)).toBeCloseTo(punch(0.5), 12);
    expect(haloEase(HALO_PUNCH_T)).toBeCloseTo(HALO_PUNCH_TRAVEL, 12);
    expect(haloEase(HALO_PUNCH_T + (1 - HALO_PUNCH_T) * 0.5)).toBeCloseTo(HALO_PUNCH_TRAVEL + (1 - HALO_PUNCH_TRAVEL) * 0.5, 12);
    // The first frames launch much faster than the previous k = 9 curve over the whole play.
    expect(haloEase(0.03)).toBeGreaterThan((1 - 2 ** -(9 * 0.03)) / (1 - 2 ** -9));
    // The coast keeps the ring on-screen late in the play (a pure k = 16 curve would already be past 0.95).
    expect(haloEase(0.8)).toBeLessThan(0.9);
    expect(haloEase(0.8)).toBeGreaterThan(0.7);
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
  it("the trailing wave is silent until the delay, then follows the same envelope at lower strength", () => {
    expect(haloTrailTime(0)).toBe(0);
    expect(haloTrailTime(HALO_TRAIL_DELAY)).toBe(0);
    expect(haloTrailTime(1)).toBeCloseTo(1, 12);
    expect(haloTrailTime(HALO_TRAIL_DELAY + (1 - HALO_TRAIL_DELAY) * 0.5)).toBeCloseTo(0.5, 12);
    expect(haloTrailStrength(0)).toBe(0);
    expect(haloTrailStrength(HALO_TRAIL_DELAY)).toBe(0);
    expect(haloTrailStrength(1)).toBe(0);
    const mid = HALO_TRAIL_DELAY + (1 - HALO_TRAIL_DELAY) * 0.03;
    expect(haloTrailStrength(mid)).toBeCloseTo(HALO_TRAIL_STRENGTH * haloStrength(0.03), 12);
    expect(haloTrailStrength(mid)).toBeLessThan(haloStrength(0.03));
  });
});

describe("halo geometry", () => {
  it("reaches just past the farthest corner of the surface", () => {
    expect(haloReach({ x: 0, y: 0 }, { width: 300, height: 400 })).toBeCloseTo(500 + HALO_BAND_PX / 2, 9);
    expect(haloReach({ x: 250, y: 100 }, { width: 300, height: 400 })).toBeCloseTo(Math.hypot(250, 300) + HALO_BAND_PX / 2, 9);
    expect(haloRadius(0, 800)).toBe(0);
    expect(haloRadius(1, 800)).toBeCloseTo(800, 9);
    expect(haloRadius(0, 800, 300)).toBe(300);
    expect(haloRadius(1, 800, 300)).toBeCloseTo(800, 9);
    expect(haloRadius(0.5, 800, 300)).toBeGreaterThan(300);
  });
  it("rises from the button: centred below it by two thirds of the width (240–650 px), starting at the button", () => {
    expect([HALO_RISE_MIN_PX, HALO_RISE_MAX_PX]).toEqual([240, 650]);
    // Desktop (1240 px wide): 827 px clamps to 650.
    expect(haloRiseCenter({ x: 120, y: 400 }, { width: 1240 })).toEqual({ x: 120, y: 1050, start: 650 });
    // Phone (390 px wide): 260 px below the button.
    expect(haloRiseCenter({ x: 195, y: 400 }, { width: 390 })).toEqual({ x: 195, y: 660, start: 260 });
    // Very narrow: never tighter than 240 px.
    expect(haloRiseCenter({ x: 150, y: 400 }, { width: 300 }).start).toBe(240);
    const center = haloRiseCenter({ x: 120, y: 400 }, { width: 1240 });
    // At t = 0 the front passes through the button; content straight below the button is already inside the circle.
    expect(Math.hypot(120 - center.x, 400 - center.y)).toBe(haloRadius(0, 2000, center.start));
    expect(Math.hypot(120 - center.x, 600 - center.y)).toBeLessThan(center.start);
    // It travels to just past the top corners, the farthest from a centre below the button.
    const slice = { width: 1240, height: 900 };
    expect(haloReach(center, slice)).toBeCloseTo(Math.hypot(1240 - 120, 1050) + HALO_BAND_PX / 2, 9);
  });
  it("weights a 150 px band around the front with (1 − x²)²", () => {
    expect(HALO_BAND_PX).toBe(150);
    expect(haloBandWeight(200, 200)).toBe(1);
    expect(haloBandWeight(200 + 37.5, 200)).toBeCloseTo((1 - 0.25) ** 2, 12);
    expect(haloBandWeight(200 + 75, 200)).toBe(0);
    expect(haloBandWeight(200 - 80, 200)).toBe(0);
  });
  it("uses the visible Compound button after the dialog closes, and falls back if it is missing or scrolled away", () => {
    const frame = { left: 0, top: 80, width: 1000, height: 700 };
    expect(haloOriginPoint({ left: 100, top: 300, width: 200, height: 40 }, frame)).toEqual({ x: 200, y: 240 });
    // Missing or zero-size button: the centre of the visible slice.
    expect(haloOriginPoint(null, frame)).toEqual({ x: 500, y: 350 });
    expect(haloOriginPoint({ left: 100, top: 300, width: 0, height: 0 }, frame)).toEqual({ x: 500, y: 350 });
    // Scrolled above the slice: clamp to the top edge, keep the horizontal centre.
    expect(haloOriginPoint({ left: 100, top: -80, width: 200, height: 40 }, frame)).toEqual({ x: 200, y: 0 });
    // Scrolled below the slice: clamp to the bottom edge.
    expect(haloOriginPoint({ left: 100, top: 900, width: 200, height: 40 }, frame)).toEqual({ x: 200, y: 700 });
  });
});

describe("halo colour by scheme", () => {
  it("uses the Halo (orange to gold) palettes", () => {
    expect(HALO_PALETTE.dark).toEqual([[255, 150, 60], [255, 190, 70], [255, 225, 120], [255, 245, 210]]);
    expect(HALO_PALETTE.light).toEqual([[255, 140, 50], [255, 175, 60], [245, 200, 80], [255, 225, 150]]);
  });
  it("tints at alpha × 0.24 in light mode and adds a low glow (× 0.45) in dark mode", () => {
    expect(haloRingAlpha(1, "light")).toBeCloseTo(0.24, 12);
    expect(haloRingAlpha(0.5, "light")).toBeCloseTo(0.12, 12);
    expect(haloRingAlpha(1, "dark")).toBeCloseTo(0.45, 12);
    expect(haloRingAlpha(0.5, "dark")).toBeCloseTo(0.225, 12);
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

describe("halo shake", () => {
  it("is a 1 px kick up with the wave and one back, settled by 150 ms, and never moves under reduced motion", () => {
    expect(HALO_SHAKE_MS).toBe(150);
    expect(HALO_SHAKE_PX).toBe(1);
    expect(haloShake(-1)).toEqual({ x: 0, y: 0 });
    expect(haloShake(0)).toEqual({ x: 0, y: -1 });
    expect(haloShake(49)).toEqual({ x: 0, y: -1 });
    expect(haloShake(50)).toEqual({ x: 0, y: 1 });
    expect(haloShake(99)).toEqual({ x: 0, y: 1 });
    expect(haloShake(100)).toEqual({ x: 0, y: 0 });
    expect(haloShake(150)).toEqual({ x: 0, y: 0 });
    expect(Math.hypot(haloShake(20).x, haloShake(20).y)).toBeLessThanOrEqual(1);
    expect(haloShake(20, true)).toEqual({ x: 0, y: 0 });
    expect(haloShake(70, true)).toEqual({ x: 0, y: 0 });
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
    // A success still held by an open dialog does not play yet.
    expect(shouldPlayHalo({ phase: "success", signature: "sig1" }, null, true)).toBe(false);
  });
  it("queues a confirmed success and releases it only after the dialog closes", () => {
    const idle = { lastPlayed: null, queued: null };
    const duringConfirm = nextHaloTrigger({ phase: "confirming", signature: "sig1" }, true, idle);
    expect(duringConfirm).toEqual({ play: false, state: idle });
    const onSuccess = nextHaloTrigger({ phase: "success", signature: "sig1" }, true, duringConfirm.state);
    expect(onSuccess).toEqual({ play: false, state: { lastPlayed: null, queued: "sig1" } });
    const afterClose = nextHaloTrigger(null, false, onSuccess.state);
    expect(afterClose).toEqual({ play: true, state: { lastPlayed: "sig1", queued: null } });
    // The same signature never plays again, even if the dialog reopens and closes.
    const again = nextHaloTrigger({ phase: "success", signature: "sig1" }, true, afterClose.state);
    expect(again.play).toBe(false);
    expect(nextHaloTrigger(null, false, again.state).play).toBe(false);
  });
  it("does not play when a non-success dialog is closed", () => {
    const failedOpen = nextHaloTrigger({ phase: "failed", signature: "sig1" }, true, { lastPlayed: null, queued: null });
    expect(failedOpen.play).toBe(false);
    expect(nextHaloTrigger(null, false, failedOpen.state).play).toBe(false);
    const confirmingOpen = nextHaloTrigger({ phase: "confirming", signature: "sig2" }, true, { lastPlayed: null, queued: null });
    expect(nextHaloTrigger(null, false, confirmingOpen.state).play).toBe(false);
  });
  it("plays immediately on confirmed success when no dialog is holding it", () => {
    expect(nextHaloTrigger({ phase: "success", signature: "sig1" }, false, { lastPlayed: null, queued: null }))
      .toEqual({ play: true, state: { lastPlayed: "sig1", queued: null } });
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
