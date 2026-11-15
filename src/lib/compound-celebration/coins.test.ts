import { describe, expect, it } from "vitest";
import {
  CATCHER, CATCHER_SPRITES, coinSymbol, CELEBRATION_MS, COIN_COUNT, COIN_SIZE, FALL_MS, KNOCK_COIN_SIZE,
  PHYSICS, REDUCED_COINS, SAMPLE_MS, STAGGER_MS, STOCK_COIN_LOGOS, beadFlights, beadKeyframes, catcherKeyframes, nextCelebrationTrigger,
  pickCoinLogos, planCatcher, reducedSpots, releaseCelebration, seedFrom, seededRandom, spriteRuns, stockTicker, type BeadFlight,
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

describe("coinSymbol", () => {
  it("names an xStock mint by its ticker even when the label is a shortened mint, so its coins are the position's own stock", () => {
    const tsla = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
    expect(coinSymbol(tsla, "XsDo…JHzoB")).toBe("TSLA");
    expect(stockTicker(coinSymbol(tsla, null))).toBe("TSLA");
    expect(pickCoinLogos([coinSymbol(tsla, "XsDo…JHzoB"), coinSymbol("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC")], 8, seededRandom(1))
      .filter((logo) => logo === STOCK_COIN_LOGOS.TSLA).length).toBeGreaterThanOrEqual(4);
  });
  it("keeps the display symbol for a token that is not a listed xStock", () => {
    expect(coinSymbol("So11111111111111111111111111111111111111112", "SOL")).toBe("SOL");
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
  it("is over in about 2.9 s, a whole number of samples", () => {
    expect(CELEBRATION_MS).toBe(STAGGER_MS + FALL_MS);
    expect(CELEBRATION_MS).toBe(2875);
    expect(CELEBRATION_MS % SAMPLE_MS).toBe(0);
    expect(FALL_MS % SAMPLE_MS).toBe(0);
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

describe("the little character", () => {
  const viewport = { width: 1280, height: 900 };
  const origin = { x: 640, y: 560 };
  const setup = (seed: number, view = viewport, from = origin) => {
    const rand = seededRandom(seed);
    const flights = beadFlights(14, from, view, rand);
    return { flights, plan: planCatcher(flights, from, view, rand) };
  };
  it("has three 12 × 14 poses in the app's colours", () => {
    for (const rows of Object.values(CATCHER_SPRITES)) {
      expect(rows).toHaveLength(CATCHER.grid.height);
      for (const row of rows) expect(row).toHaveLength(CATCHER.grid.width);
    }
    const runs = spriteRuns(CATCHER_SPRITES.stand);
    expect(runs.every((run) => /^#[0-9a-f]{6}$/.test(run.color) && run.width >= 1)).toBe(true);
    expect(runs.some((run) => run.color === "#f3e76b")).toBe(true);
  });
  it("appears under the OK on the floor and collects up to three coins as they land, never faster than it can run", () => {
    for (const seed of [1, 2, 3, 11, 42]) {
      const { flights, plan } = setup(seed);
      expect(plan.startX).toBe(origin.x);
      expect(plan.feetY).toBe(viewport.height - CATCHER.feetMargin);
      expect(plan.pixel).toBe(4);
      expect(plan.catches.length).toBeGreaterThanOrEqual(1);
      expect(plan.catches.length).toBeLessThanOrEqual(CATCHER.maxCatches);
      let x = plan.startX, t = CATCHER.appearMs / 1000;
      for (const caught of plan.catches) {
        const flight = flights[caught.coin]!;
        // It is where the coin first touches the floor, when it does.
        const landing = flight.frames.find((frame) => frame.y >= flight.floorY - 0.01)!;
        expect(caught.t).toBeCloseTo(landing.t + flight.delay / 1000, 9);
        expect(Math.abs(caught.x - landing.x)).toBeLessThanOrEqual(plan.width / 2 + 1e-9);
        expect(Math.abs(caught.x - x) / (caught.t - t)).toBeLessThanOrEqual(CATCHER.runSpeed + 1e-6);
        expect(flight.catchAt).toBeCloseTo(caught.t - flight.delay / 1000, 9);
        const frame = plan.frames.find((f) => f.t >= caught.t - 1e-9)!;
        expect(Math.abs(frame.x - caught.x)).toBeLessThanOrEqual(CATCHER.runSpeed * (SAMPLE_MS / 1000) + 1e-6);
        x = caught.x; t = caught.t;
      }
      // Coins it did not collect are left alone.
      expect(flights.filter((flight) => flight.catchAt !== undefined && flight.catchAt !== null)).toHaveLength(plan.catches.length);
    }
  });
  it("a collected coin vanishes where it was caught", () => {
    const { flights, plan } = setup(2);
    const caught = flights[plan.catches[0]!.coin]!;
    const { move } = beadKeyframes(caught, origin);
    const after = move.filter((frame) => frame.offset > (caught.catchAt! + 0.03) / (FALL_MS / 1000));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((frame) => frame.opacity === 0 && frame.transform === after[0]!.transform)).toBe(true);
  });
  it("then a big coin of its own stock drops on its head, and it falls over and lies on the floor", () => {
    for (const seed of [1, 2, 3, 11, 42]) {
      const { plan } = setup(seed);
      expect(plan.hitT).toBeGreaterThanOrEqual(CATCHER.hitAtMs / 1000);
      expect(plan.hitT).toBeGreaterThanOrEqual(plan.catches.at(-1)!.t + CATCHER.afterCatchMs / 1000 - 1e-9);
      expect(plan.knock.size).toBe(KNOCK_COIN_SIZE.wide);
      const standing = plan.frames.find((frame) => frame.t >= plan.hitT - 1e-9)!;
      // The coin is over its head, touching it, when it hits.
      const atHit = plan.knock.frames.reduce((a, b) => (Math.abs(b.t - plan.hitT) < Math.abs(a.t - plan.hitT) ? b : a));
      expect(Math.abs(atHit.x - standing.x)).toBeLessThan(1);
      expect(atHit.y + plan.knock.size / 2).toBeGreaterThan(plan.feetY - plan.height - 12);
      expect(atHit.y + plan.knock.size / 2).toBeLessThan(plan.feetY - plan.height + 12);
      // It comes from above the screen and is not seen before it starts falling.
      expect(plan.knock.frames[0]!.y).toBeLessThan(0);
      expect(plan.knock.frames[0]!.opacity).toBe(0);
      // Standing before the hit, lying (−90°) shortly after, still where it was hit.
      expect(plan.frames.filter((frame) => frame.t < plan.hitT).every((frame) => frame.tilt === 0)).toBe(true);
      const lying = plan.frames.filter((frame) => frame.t >= plan.hitT + CATCHER.tipMs / 1000);
      expect(lying.every((frame) => frame.tilt === -90 && frame.pose === "stand" && Math.abs(frame.x - standing.x) < 1e-9)).toBe(true);
    }
  });
  it("runs in two alternating poses while moving, stays on screen, and fades out with the coins", () => {
    const { plan } = setup(3);
    expect(plan.frames.some((frame) => frame.pose === "runA")).toBe(true);
    expect(plan.frames.some((frame) => frame.pose === "runB")).toBe(true);
    for (const frame of plan.frames) {
      expect(frame.x).toBeGreaterThanOrEqual(plan.width / 2);
      expect(frame.x).toBeLessThanOrEqual(viewport.width - plan.width / 2);
    }
    expect(plan.frames[0]!.opacity).toBe(0);
    expect(plan.frames.at(-1)!.opacity).toBe(0);
    expect(plan.frames.at(-1)!.t).toBeCloseTo(CELEBRATION_MS / 1000, 9);
    expect(plan.knock.frames.at(-1)!.opacity).toBe(0);
    const { move, tilt, poses } = catcherKeyframes(plan);
    expect(move[0]!.offset).toBe(0);
    expect(move.at(-1)!.offset).toBe(1);
    // Lying on the floor, not through it: lifted by half its width as it tips.
    expect(tilt.at(-1)!.transform).toBe(`translateY(-${(plan.width / 2).toFixed(1)}px) rotate(-90deg)`);
    expect(poses.stand.every((frame) => frame.easing === "step-end")).toBe(true);
    // Exactly one pose shows at a time.
    poses.stand.forEach((frame, i) => expect(frame.opacity + poses.runA[i]!.opacity + poses.runB[i]!.opacity).toBe(1));
  });
  it("is smaller on a phone and keeps inside a 390 px screen", () => {
    const { plan } = setup(5, { width: 390, height: 844 }, { x: 195, y: 545 });
    expect(plan.pixel).toBe(3);
    expect(plan.knock.size).toBe(KNOCK_COIN_SIZE.narrow);
    for (const frame of plan.frames) {
      expect(frame.x).toBeGreaterThanOrEqual(plan.width / 2);
      expect(frame.x).toBeLessThanOrEqual(390 - plan.width / 2);
    }
    for (const frame of plan.knock.frames) {
      expect(frame.x).toBeGreaterThanOrEqual(plan.knock.size / 2 - 1e-6);
      expect(frame.x).toBeLessThanOrEqual(390 - plan.knock.size / 2 + 1e-6);
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
