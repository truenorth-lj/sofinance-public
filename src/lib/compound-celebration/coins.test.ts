import { describe, expect, it } from "vitest";
import {
  BURST_DELAY_MS, CELEBRATION_MS, COIN_COUNT, COIN_SIZE, FLIGHT_MS, REDUCED_COINS, STAGGER_MS, STOCK_COIN_LOGOS, WOBBLE_KEYFRAMES, WOBBLE_MS,
  burstReach, coinFlights, flightKeyframes, nextCelebrationTrigger, pickCoinLogos, reducedSpots, seedFrom, seededRandom, stockTicker,
  visibleSlice,
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
    // The own stock is spread through the burst, not all first.
    expect(logos.slice(0, 7).every((url) => url === logo("NVDA"))).toBe(false);
    // Phone: 9 coins, 5 of them the own stock.
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
    const rand = seededRandom(seedFrom("sig-a"));
    const values = Array.from({ length: 200 }, rand);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe("burst flight", () => {
  const reach = 400;
  const flights = coinFlights(14, reach, seededRandom(11));
  it("fans upward out of the box: most coins rise, none drops far below the button", () => {
    expect(flights).toHaveLength(14);
    expect(flights.filter((flight) => flight.dy < 0).length).toBeGreaterThanOrEqual(11);
    expect(Math.max(...flights.map((flight) => flight.dy))).toBeLessThan(0.25 * reach);
    expect(flights.some((flight) => flight.dx < -reach * 0.3)).toBe(true);
    expect(flights.some((flight) => flight.dx > reach * 0.3)).toBe(true);
    expect(Math.max(...flights.map((flight) => Math.hypot(flight.dx, flight.dy)))).toBeLessThanOrEqual(reach * 1.1);
  });
  it("puts coins at different depths: near ones larger and slightly soft, far ones smaller", () => {
    for (const flight of flights) {
      expect(flight.size).toBeGreaterThanOrEqual(COIN_SIZE.far);
      expect(flight.size).toBeLessThanOrEqual(COIN_SIZE.near);
      expect(flight.blur).toBeLessThanOrEqual(1.7);
      expect(flight.delay).toBeGreaterThanOrEqual(0);
      expect(flight.delay).toBeLessThanOrEqual(STAGGER_MS);
      if (flight.depth > 0.82) expect(flight.blur).toBeGreaterThan(0);
      if (flight.depth >= 0.12 && flight.depth <= 0.82) expect(flight.blur).toBe(0);
    }
    const sorted = [...flights].sort((a, b) => a.depth - b.depth);
    expect(sorted[0]!.size).toBeLessThan(sorted.at(-1)!.size);
  });
  it("leaves the button small and invisible, ends at rest where planned, faded out, and turns as it flies", () => {
    const flight = flights[0]!;
    const { move, turn } = flightKeyframes(flight);
    expect(move[0]).toMatchObject({ offset: 0, opacity: 0, transform: "translate3d(0.0px, 0.0px, 0) scale(0.250)" });
    expect(move.at(-1)).toMatchObject({ offset: 1, opacity: 0, transform: `translate3d(${flight.dx.toFixed(1)}px, ${flight.dy.toFixed(1)}px, 0) scale(1.000)` });
    expect(move.some((frame) => frame.opacity === 1)).toBe(true);
    expect(move.map((frame) => frame.offset)).toEqual([...move.map((frame) => frame.offset)].sort((a, b) => a - b));
    expect(turn[0]!.transform).toBe(`rotateX(${flight.turnFrom.x.toFixed(1)}deg) rotateY(${flight.turnFrom.y.toFixed(1)}deg) rotateZ(${flight.turnFrom.z.toFixed(1)}deg)`);
    expect(turn.at(-1)!.transform).toBe(`rotateX(${flight.turnTo.x.toFixed(1)}deg) rotateY(${flight.turnTo.y.toFixed(1)}deg) rotateZ(${flight.turnTo.z.toFixed(1)}deg)`);
    expect(Math.abs(flight.turnFrom.y)).toBeGreaterThanOrEqual(25);
  });
  it("wobbles the button a little (scale 0.94–1.06, tilt ≤ 4°) and settles where it started", () => {
    expect(WOBBLE_MS).toBe(300);
    expect(WOBBLE_KEYFRAMES[0]!.transform).toBe("scale(1) rotate(0deg)");
    expect(WOBBLE_KEYFRAMES.at(-1)!.transform).toBe("scale(1) rotate(0deg)");
    for (const frame of WOBBLE_KEYFRAMES) {
      const scales = [...frame.transform.matchAll(/scale\(([\d.]+)(?:, ([\d.]+))?\)/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean).map(Number);
      const tilt = Number(/rotate\((-?[\d.]+)deg\)/.exec(frame.transform)![1]);
      expect(Math.min(...scales)).toBeGreaterThanOrEqual(0.94);
      expect(Math.max(...scales)).toBeLessThanOrEqual(1.06);
      expect(Math.abs(tilt)).toBeLessThanOrEqual(4);
    }
  });
  it("is over in about 1.6 s: coins leave just before the wobble settles", () => {
    expect(BURST_DELAY_MS).toBeLessThan(WOBBLE_MS);
    expect(FLIGHT_MS).toBe(1300);
    expect(CELEBRATION_MS).toBe(BURST_DELAY_MS + STAGGER_MS + FLIGHT_MS);
    expect(CELEBRATION_MS).toBe(1630);
  });
  it("flies across most of the visible area, within 120–520 px", () => {
    expect(burstReach({ width: 1240, height: 900 })).toBe(520);
    expect(burstReach({ width: 390, height: 844 })).toBeCloseTo(214.5, 9);
    expect(burstReach({ width: 100, height: 100 })).toBe(120);
  });
  it("reduced motion: three still coins beside the button, no turn", () => {
    const spots = reducedSpots();
    expect(spots).toHaveLength(REDUCED_COINS);
    for (const spot of spots) {
      expect(spot.turnFrom).toEqual({ x: 0, y: 0, z: 0 });
      expect(spot.turnTo).toEqual({ x: 0, y: 0, z: 0 });
      expect(Math.hypot(spot.dx, spot.dy)).toBeLessThanOrEqual(75);
      expect(spot.dy).toBeLessThan(0);
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
  it("never plays after a failed or unconfirmed send", () => {
    const failed = nextCelebrationTrigger({ phase: "failed", signature: "s1" }, true, empty);
    expect(nextCelebrationTrigger(null, false, failed.state).play).toBeNull();
    const confirming = nextCelebrationTrigger({ phase: "confirming", signature: "s2" }, true, empty);
    expect(nextCelebrationTrigger(null, false, confirming.state).play).toBeNull();
  });
});

describe("visible slice", () => {
  it("is the content area ∩ viewport, in content-area coordinates", () => {
    expect(visibleSlice({ left: 20, top: -700, width: 1240, height: 2400 }, { width: 1280, height: 900 }))
      .toEqual({ x: 0, y: 700, width: 1240, height: 900 });
    expect(visibleSlice({ left: 0, top: 1000, width: 400, height: 300 }, { width: 400, height: 800 }))
      .toEqual({ x: 0, y: 0, width: 400, height: 0 });
  });
});
