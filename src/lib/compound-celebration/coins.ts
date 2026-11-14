/**
 * Compound success celebration: tokenized-stock coins burst out of the Compound button like a gift box opening.
 * Pure functions (coin choice, flight paths, timing, trigger) so the animation can be tested without a browser.
 */
import { MANUAL_TOKEN_ICONS } from "@/lib/token-icons/map";

/** The button wobbles like a box about to open, then the coins leave. */
export const WOBBLE_MS = 300;
/** Coins leave this long after the wobble starts (just before it settles). */
export const BURST_DELAY_MS = 240;
/** One coin's flight, from leaving the button to gone. */
export const FLIGHT_MS = 1300;
/** Last coin leaves this long after the first. */
export const STAGGER_MS = 90;
/** Whole play, wobble included: the overlay is removed after this. */
export const CELEBRATION_MS = BURST_DELAY_MS + STAGGER_MS + FLIGHT_MS;
/** Reduced motion: no wobble and no flight; a few coins fade in and out where they are. */
export const REDUCED_MS = 700;
export const REDUCED_COINS = 3;
/** How many coins burst out, and how many of them are the position's own stock (when it has an xStock logo). */
export const COIN_COUNT = { wide: 14, narrow: 9 } as const;
export const OWN_SHARE = 0.5;
/** Coin diameter in CSS px from the far plane (depth 0) to the near plane (depth 1). */
export const COIN_SIZE = { far: 34, near: 70 } as const;

export type Rand = () => number;

/** Small deterministic generator (mulberry32) so one play is reproducible from its seed. */
export function seededRandom(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from a string (the transaction signature). */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** Ticker → xStock logo, from the app's own manual icon list (the xStocks issuer's logo CDN). */
export const STOCK_COIN_LOGOS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(MANUAL_TOKEN_ICONS
  .map((row) => [/\/logos\/tokens\/([A-Z]+)x\.png$/.exec(row.image)?.[1], row.image] as const)
  .filter((entry): entry is readonly [string, string] => Boolean(entry[0]))));

/** The plain ticker behind a token symbol: "NVDAx" and "NVDA" → "NVDA". Null when it has no xStock logo (USDC, SOL…). */
export function stockTicker(symbol: string | null | undefined): string | null {
  const match = /^([A-Za-z]{1,6}?)(x|on)?$/.exec((symbol ?? "").trim());
  const ticker = match?.[1]?.toUpperCase() ?? "";
  return ticker && STOCK_COIN_LOGOS[ticker] ? ticker : null;
}

/**
 * Logos for one burst: about half are the position's own stock (the first symbol with an xStock logo), the rest a
 * shuffled mix of the other xStocks. Without an own stock, all of them are the mix.
 */
export function pickCoinLogos(symbols: readonly (string | null | undefined)[], count: number, rand: Rand): string[] {
  const own = symbols.map(stockTicker).find((ticker): ticker is string => ticker !== null) ?? null;
  const others = Object.keys(STOCK_COIN_LOGOS).filter((ticker) => ticker !== own);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [others[i], others[j]] = [others[j]!, others[i]!];
  }
  const ownCount = own ? Math.round(count * OWN_SHARE) : 0;
  const tickers = [...Array.from({ length: ownCount }, () => own!), ...Array.from({ length: count - ownCount }, (_, i) => others[i % others.length]!)];
  // Interleave so the own stock is spread through the burst rather than leaving first.
  for (let i = tickers.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [tickers[i], tickers[j]] = [tickers[j]!, tickers[i]!];
  }
  return tickers.map((ticker) => STOCK_COIN_LOGOS[ticker]!);
}

export type CoinFlight = {
  /** 0 = far (small, a little soft), 1 = near (large, slightly out of focus). */
  depth: number;
  size: number;
  blur: number;
  delay: number;
  /** Where the coin comes to rest relative to the button centre, in CSS px. */
  dx: number;
  dy: number;
  /** Tilt at launch and at rest (degrees): the coin turns as it flies, so its rim shows. */
  turnFrom: { x: number; y: number; z: number };
  turnTo: { x: number; y: number; z: number };
};

/**
 * Flight plans for a burst out of a box: an upward fan from just below the button's line on the left, over the top, to
 * just below it on the right, reaching about `reach` px. Nearer coins travel further and are larger.
 */
export function coinFlights(count: number, reach: number, rand: Rand): CoinFlight[] {
  return Array.from({ length: count }, (_, index) => {
    // Spread the angles evenly over the fan, then jitter, so the burst has no empty side.
    const slot = (index + 0.15 + rand() * 0.7) / count;
    const angle = (-192 + slot * 204) * (Math.PI / 180);
    const depth = rand();
    const distance = reach * (0.45 + 0.55 * rand()) * (0.75 + 0.35 * depth);
    const size = COIN_SIZE.far + (COIN_SIZE.near - COIN_SIZE.far) * depth;
    const blur = depth > 0.82 ? (depth - 0.82) * 9 : depth < 0.12 ? 0.6 : 0;
    const spin = (rand() < 0.5 ? -1 : 1) * (25 + rand() * 30);
    return {
      depth, size, blur: Math.round(blur * 10) / 10, delay: Math.round(rand() * STAGGER_MS),
      dx: Math.cos(angle) * distance, dy: Math.sin(angle) * distance * 0.85,
      turnFrom: { x: (rand() - 0.5) * 50, y: -spin, z: (rand() - 0.5) * 30 },
      turnTo: { x: (rand() - 0.5) * 24, y: spin * 0.4, z: (rand() - 0.5) * 20 },
    };
  });
}

/** Ease-out (cubic): fast out of the box, gliding to rest. */
export const easeOutCubic = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/**
 * Keyframes along one flight, sampled so a gentle arc (a little lift, then settling) survives linear interpolation.
 * `move` (outer layer): position, size and opacity — pops in over the first 8%, holds, fades over the last 40%.
 * `turn` (inner layer): the tilt. Kept apart because opacity below 1 flattens 3D on the element it is set on.
 */
export function flightKeyframes(flight: CoinFlight, steps = 12): {
  move: { transform: string; opacity: number; offset: number }[];
  turn: { transform: string; offset: number }[];
} {
  const move: { transform: string; opacity: number; offset: number }[] = [];
  const turn: { transform: string; offset: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const travel = easeOutCubic(t);
    const lift = -18 * Math.sin(Math.PI * Math.min(1, t * 1.4)) * (0.5 + flight.depth);
    const scale = 0.25 + 0.75 * easeOutCubic(Math.min(1, t * 2.2));
    const mix = (from: number, to: number) => from + (to - from) * travel;
    const opacity = t < 0.08 ? t / 0.08 : t > 0.6 ? Math.max(0, 1 - (t - 0.6) / 0.4) : 1;
    move.push({ offset: t, opacity: Math.round(opacity * 1000) / 1000,
      transform: `translate3d(${(flight.dx * travel).toFixed(1)}px, ${(flight.dy * travel + lift).toFixed(1)}px, 0) scale(${scale.toFixed(3)})` });
    turn.push({ offset: t, transform: `rotateX(${mix(flight.turnFrom.x, flight.turnTo.x).toFixed(1)}deg) `
      + `rotateY(${mix(flight.turnFrom.y, flight.turnTo.y).toFixed(1)}deg) rotateZ(${mix(flight.turnFrom.z, flight.turnTo.z).toFixed(1)}deg)` });
  }
  return { move, turn };
}

/** Reduced motion: a few still coins around the button (no travel, no turn), fading in and out where they are. */
export function reducedSpots(count = REDUCED_COINS): CoinFlight[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (-150 + (120 * i) / Math.max(1, count - 1)) * (Math.PI / 180);
    const still = { x: 0, y: 0, z: 0 };
    return { depth: 0.5, size: (COIN_SIZE.far + COIN_SIZE.near) / 2, blur: 0, delay: 0,
      dx: Math.round(Math.cos(angle) * 70), dy: Math.round(Math.sin(angle) * 60), turnFrom: still, turnTo: still };
  });
}

/** The box wobble on the button: a squash, two small tilts, settle. Scale stays within 0.94–1.06, tilt within ±4°. */
export const WOBBLE_KEYFRAMES: readonly { transform: string; offset: number }[] = Object.freeze([
  { offset: 0, transform: "scale(1) rotate(0deg)" },
  { offset: 0.18, transform: "scale(0.94, 0.96) rotate(0deg)" },
  { offset: 0.42, transform: "scale(1.06) rotate(-4deg)" },
  { offset: 0.66, transform: "scale(1.03) rotate(3deg)" },
  { offset: 0.86, transform: "scale(1.01) rotate(-1deg)" },
  { offset: 1, transform: "scale(1) rotate(0deg)" },
]);

/** How far coins fly: most of the visible content area, without leaving a phone screen entirely. */
export function burstReach(area: { width: number; height: number }): number {
  return Math.max(120, Math.min(520, Math.min(area.width * 0.55, area.height * 0.65)));
}

export type CelebrationTriggerState = { lastPlayed: string | null; queued: string | null };

/**
 * Advances the trigger state. A confirmed success is queued once per signature. It plays at once when nothing holds the
 * result (no app dialog open), or after that hold is released. Closing a dialog that is not a confirmed success never
 * plays. `held` is true while the app's result dialog is still open.
 */
export function nextCelebrationTrigger(
  feedback: { phase: string; signature: string } | null,
  held: boolean,
  state: CelebrationTriggerState,
): { play: string | null; state: CelebrationTriggerState } {
  let { lastPlayed, queued } = state;
  const phase = feedback?.phase ?? null;
  const signature = feedback?.signature || null;
  if (phase === "success" && signature && signature !== lastPlayed) queued = signature;
  else if (phase && phase !== "success" && signature && signature === queued) queued = null;
  const play = queued && queued !== lastPlayed && !held ? queued : null;
  if (play) {
    lastPlayed = play;
    queued = null;
  }
  return { play, state: { lastPlayed, queued } };
}

export type CelebrationSlice = { x: number; y: number; width: number; height: number };

/** The part of the content area the user can see (content area ∩ viewport), in content-area coordinates. */
export function visibleSlice(area: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number }): CelebrationSlice {
  const left = Math.max(area.left, 0), top = Math.max(area.top, 0);
  const right = Math.min(area.left + area.width, viewport.width), bottom = Math.min(area.top + area.height, viewport.height);
  return { x: left - area.left, y: top - area.top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
