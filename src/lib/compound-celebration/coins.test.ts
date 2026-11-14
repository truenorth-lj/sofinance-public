import { describe, expect, it } from "vitest";
import {
  CELEBRATION_MS, COIN_COUNT, COIN_SIZE, FALL_MS, OK_PRESS_SCALE, OK_RELEASE_KEYFRAMES, OK_RELEASE_MS, PHYSICS, REDUCED_COINS, SAMPLE_MS, STAGGER_MS,
  STOCK_COIN_LOGOS, beadFlights, beadKeyframes, nextCelebrationTrigger, pickCoinLogos, reducedSpots, releaseCelebration, seedFrom, seededRandom,
  stockTicker, type BeadFlight,
} from "./coins";

const logo = (ticker: string) => `https://xstocks-metadata.backed.fi/logos/tokens/${ticker}x.png`;

describe("stock coins", () => {
  it("takes the xStock logos from the app's own icon list", () => {
    expect(Object.keys(STOCK_COIN_LOGOS)).toEqual(expect.arrayContaining(["NVDA", "TSLA", "AAPL", "GOOGL", "AMZN", "META", "SPCX"]));
    expect(STOCK_COIN_LOGOS.NVDA).toBe(logo("NVDA"));
    expect(Object.values(STOCK_COIN_LOGOS).every((url) => url.startsWith("https://xstocks-metadata.backed.fi/logos/tokens/"))).toBe(true);
  });
  it("reads the plain ticker behind a token symbol, and nothing for non-stocks", () => {
    expect(stockTicker("NVDAx")).toBe("NVDA");
    expect(stockTicker("NVDA")).toBe("NVDA");
    expect(stockTicker("TSLAon")).toBe("TSLA");
    expect(stockTicker("GOOGLx")).toBe("GOOGL");
    expect(stockTicker("AMDx")).toBe("AMD");
    expect(stockTicker("SPCXx")).toBe("SPCX");
    expect(stockTicker("SPCX")).toBe("SPCX");
    for (const symbol of ["USDC", "SOL", "", "  ", null, undefined]) expect(stockTicker(symbol)).toBeNull();
  });
  it("makes about half the coins the position's own stock and mixes the rest from other stocks", () => {
    const logos = pickCoinLogos(["NVDAx", "USDC"], COIN_COUNT.wide, seededRandom(7));
    expect(logos).toHaveLength(14);
    expect(logos.filter((url) => url === logo("NVDA"))).toHaveLength(7);
    const others = logos.filter((url) => url !== logo("NVDA"));
    expect(new Set(others).size).toBe(others.length);
    expect(others.every((url) => Object.values(STOCK_COIN_LOGOS).includes(url))).toBe(true);
    expect(logos.slice(0, 7).every((url) => url === logo("NVDA"))).toBe(false);
    expect(pickCoinLogos(["USDC", "TSLAx"], COIN_COUNT.narrow, seededRandom(7)).filter((url) => url === logo("TSLA"))).toHaveLength(5);
  });
  it("uses only the mix when the position has no stock with a logo, and is the same for the same seed", () => {
    const logos = pickCoinLogos(["SOL", "USDC"], 14, seededRandom(3));
    expect(new Set(logos).size).toBe(14);
    expect(pickCoinLogos(["SOL", "USDC"], 14, seededRandom(3))).toEqual(logos);
    expect(pickCoinLogos(["SOL", "USDC"], 14, seededRandom(4))).not.toEqual(logos);
  });
  it("seeds from the signature deterministically", () => {
    expect(seedFrom("sig-a")).toBe(seedFrom("sig-a"));
    expect(seedFrom("sig-a")).not.toBe(seedFrom("sig-b"));
    const values = Array.from({ length: 200 }, seededRandom(seedFrom("sig-a")));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe("OK button press", () => {
  it("shrinks to 0.94 while pressed and pops back past its size on release, in 180 ms", () => {
    expect(OK_PRESS_SCALE).toBe(0.94);
    expect(OK_RELEASE_MS).toBe(180);
    expect(OK_RELEASE_KEYFRAMES.map((frame) => frame.transform)).toEqual(["scale(0.94)", "scale(1.06)", "scale(1)"]);
    expect(OK_RELEASE_KEYFRAMES.map((frame) => frame.offset)).toEqual([0, 0.5, 1]);
  });
});

/** Local minima of y after the first floor contact: the tops of the bounces. */
function bouncePeaks(flight: BeadFlight): number[] {
  const first = flight.frames.findIndex((frame) => frame.y >= flight.floorY - 0.01);
  const peaks: number[] = [];
  for (let i = Math.max(1, first + 1); i < flight.frames.length - 1; i++) {
    const [a, b, c] = [flight.frames[i - 1]!.y, flight.frames[i]!.y, flight.frames[i + 1]!.y];
    if (b < a && b <= c && b < flight.floorY - 4) peaks.push(b);
  }
  return peaks;
}

describe("beads falling to the floor", () => {
  const viewport = { width: 1280, height: 900 };
  const origin = { x: 640, y: 560 };
  const flights = beadFlights(14, origin, viewport, seededRandom(11));
  it("pops out of the OK button: starts there, small and invisible, and first goes up", () => {
    expect(flights).toHaveLength(14);
    for (const flight of flights) {
      expect(flight.frames[0]).toMatchObject({ t: 0, x: origin.x, y: origin.y, opacity: 0, scale: 0.3 });
      expect(flight.delay).toBeGreaterThanOrEqual(0);
      expect(flight.delay).toBeLessThanOrEqual(STAGGER_MS);
    }
    expect(flights.filter((flight) => flight.frames[4]!.y < origin.y).length).toBe(14);
  });
  it("falls to the bottom of the screen and bounces lower each time", () => {
    for (const flight of flights) {
      expect(flight.frames.every((frame) => frame.y <= flight.floorY + 1e-6)).toBe(true);
      expect(flight.frames.some((frame) => Math.abs(frame.y - flight.floorY) < 1e-6)).toBe(true);
      expect(flight.floorY).toBeLessThanOrEqual(viewport.height - PHYSICS.floorMargin - flight.size / 2 + 1e-9);
      expect(flight.floorY).toBeGreaterThanOrEqual(viewport.height - PHYSICS.floorMargin - flight.size / 2 - PHYSICS.depthLift - 1e-9);
      const peaks = bouncePeaks(flight);
      for (let i = 1; i < peaks.length; i++) expect(peaks[i]!).toBeGreaterThanOrEqual(peaks[i - 1]! - 0.5);
    }
    expect(flights.filter((flight) => flight.bounces >= 2).length).toBeGreaterThanOrEqual(10);
    // Far coins land higher than near ones (depth).
    const sorted = [...flights].sort((a, b) => a.depth - b.depth);
    expect(sorted[0]!.floorY).toBeLessThan(sorted.at(-1)!.floorY);
    expect(sorted[0]!.size).toBeLessThan(sorted.at(-1)!.size);
    for (const flight of flights) {
      expect(flight.size).toBeGreaterThanOrEqual(COIN_SIZE.far);
      expect(flight.size).toBeLessThanOrEqual(COIN_SIZE.near);
      expect(flight.blur).toBeLessThanOrEqual(1.7);
    }
  });
  it("stays on screen (bounces off the sides), spreads to both sides, wobbles without flipping, and fades out", () => {
    for (const flight of flights) {
      for (const frame of flight.frames) {
        expect(frame.x).toBeGreaterThanOrEqual(flight.size / 2 - 1e-6);
        expect(frame.x).toBeLessThanOrEqual(viewport.width - flight.size / 2 + 1e-6);
        expect(Math.abs(frame.tiltY)).toBeLessThanOrEqual(60);
      }
      expect(flight.frames.at(-1)).toMatchObject({ t: FALL_MS / 1000, opacity: 0 });
      expect(flight.frames.find((frame) => frame.t >= 1)!.opacity).toBe(1);
      expect(flight.frames).toHaveLength(FALL_MS / SAMPLE_MS + 1);
    }
    expect(flights.some((flight) => flight.frames.at(-1)!.x < origin.x - 150)).toBe(true);
    expect(flights.some((flight) => flight.frames.at(-1)!.x > origin.x + 150)).toBe(true);
  });
  it("keeps a phone's coins inside a 390 px screen", () => {
    const phone = beadFlights(9, { x: 195, y: 545 }, { width: 390, height: 844 }, seededRandom(5));
    for (const flight of phone) for (const frame of flight.frames) {
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.x).toBeLessThanOrEqual(390);
      expect(frame.y).toBeLessThanOrEqual(844);
    }
  });
  it("turns into Web Animations keyframes relative to the start, offsets 0 → 1", () => {
    const { move, turn } = beadKeyframes(flights[0]!, origin);
    expect(move[0]).toEqual({ offset: 0, opacity: 0, transform: "translate3d(0.0px, 0.0px, 0) scale(0.300)" });
    expect(move.at(-1)!.offset).toBe(1);
    expect(move.at(-1)!.opacity).toBe(0);
    expect(move.map((frame) => frame.offset)).toEqual([...move.map((frame) => frame.offset)].sort((a, b) => a - b));
    expect(turn).toHaveLength(move.length);
    expect(turn[0]!.transform).toMatch(/^rotateY\(-?\d+\.\ddeg\) rotateZ\(0\.0deg\)$/);
  });
  it("is over in about 2.2 s", () => {
    expect(CELEBRATION_MS).toBe(STAGGER_MS + FALL_MS);
    expect(CELEBRATION_MS).toBe(2180);
  });
  it("reduced motion: three still coins just above and beside the origin", () => {
    const spots = reducedSpots(origin);
    expect(spots).toHaveLength(REDUCED_COINS);
    for (const spot of spots) {
      expect(Math.hypot(spot.x - origin.x, spot.y - origin.y)).toBeLessThanOrEqual(85);
      expect(spot.y).toBeLessThan(origin.y);
    }
  });
});

describe("celebration trigger", () => {
  const empty = { lastPlayed: null, queued: null };
  it("plays once per confirmed signature, never while submitting or confirming", () => {
    expect(nextCelebrationTrigger(null, false, empty).play).toBeNull();
    expect(nextCelebrationTrigger({ phase: "submitting", signature: "" }, false, empty).play).toBeNull();
    expect(nextCelebrationTrigger({ phase: "confirming", signature: "s1" }, false, empty).play).toBeNull();
    const first = nextCelebrationTrigger({ phase: "success", signature: "s1" }, false, empty);
    expect(first.play).toBe("s1");
    expect(nextCelebrationTrigger({ phase: "success", signature: "s1" }, false, first.state).play).toBeNull();
    expect(nextCelebrationTrigger({ phase: "success", signature: "s2" }, false, first.state).play).toBe("s2");
  });
  it("holds a confirmed success while the result dialog is open and plays when it closes", () => {
    const held = nextCelebrationTrigger({ phase: "success", signature: "s1" }, true, empty);
    expect(held.play).toBeNull();
    expect(held.state.queued).toBe("s1");
    expect(nextCelebrationTrigger(null, false, held.state).play).toBe("s1");
  });
  it("the OK release plays the held success at once, and closing the dialog afterwards does not repeat it", () => {
    const held = nextCelebrationTrigger({ phase: "success", signature: "s1" }, true, empty);
    const released = releaseCelebration(held.state);
    expect(released.play).toBe("s1");
    expect(nextCelebrationTrigger(null, false, released.state).play).toBeNull();
    expect(releaseCelebration(released.state).play).toBeNull();
    expect(releaseCelebration(empty).play).toBeNull();
  });
  it("never plays after a failed or unconfirmed send", () => {
    const failed = nextCelebrationTrigger({ phase: "failed", signature: "s1" }, true, empty);
    expect(nextCelebrationTrigger(null, false, failed.state).play).toBeNull();
    expect(releaseCelebration(failed.state).play).toBeNull();
    const confirming = nextCelebrationTrigger({ phase: "confirming", signature: "s2" }, true, empty);
    expect(nextCelebrationTrigger(null, false, confirming.state).play).toBeNull();
  });
});
