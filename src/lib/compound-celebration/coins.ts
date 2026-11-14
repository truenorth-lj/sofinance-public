/**
 * Compound success celebration: when the "Compound confirmed" OK is released, tokenized-stock coins pop out of it and
 * fall like beads to the bottom of the screen, bounce, settle and fade. Pure functions (coin choice, physics, timing,
 * trigger) so the animation can be tested without a browser.
 */
import { MANUAL_TOKEN_ICONS } from "@/lib/token-icons/map";

/** The OK button shrinks to this while pressed (CSS :active). */
export const OK_PRESS_SCALE = 0.94;
/** On release it pops back a little past its size, then the dialog closes. Coins leave at the release. */
export const OK_RELEASE_MS = 180;
export const OK_RELEASE_KEYFRAMES: readonly { offset: number; transform: string }[] = Object.freeze([
  { offset: 0, transform: `scale(${OK_PRESS_SCALE})` },
  { offset: 0.5, transform: "scale(1.06)" },
  { offset: 1, transform: "scale(1)" },
]);

/** One coin: pop out, fall, bounce, settle and fade. */
export const FALL_MS = 2100;
/** Fading starts at this fraction of a coin's play. */
export const FADE_FROM = 0.78;
/** Last coin leaves this long after the first. */
export const STAGGER_MS = 80;
/** Whole play: the overlay is removed after this. */
export const CELEBRATION_MS = STAGGER_MS + FALL_MS;
/** Keyframe spacing along a simulated path. */
export const SAMPLE_MS = 25;
/** Physics in CSS px and seconds. Restitution is the share of speed kept by a bounce. */
export const PHYSICS = Object.freeze({
  gravity: 3000, restitution: { min: 0.4, max: 0.56 }, floorFriction: 0.72, wallBounce: 0.6, restSpeed: 70,
  /** Gap between a near coin and the bottom of the screen; far coins land up to `depthLift` px higher. */
  floorMargin: 12, depthLift: 60,
});
/** Reduced motion: no pop and no fall; a few coins fade in and out where they are. */
export const REDUCED_MS = 700;
export const REDUCED_COINS = 3;
/** How many coins pop out, and how many of them are the position's own stock (when it has an xStock logo). */
export const COIN_COUNT = { wide: 14, narrow: 9 } as const;
export const OWN_SHARE = 0.5;
/** Coin diameter in CSS px from the far plane (depth 0) to the near plane (depth 1). */
export const COIN_SIZE = { far: 34, near: 70 } as const;

export type Rand = () => number;
export type Point = { x: number; y: number };
export type Viewport = { width: number; height: number };

const clamp = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value);

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
 * Logos for one play: about half are the position's own stock (the first symbol with an xStock logo), the rest a
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
  // Interleave so the own stock is spread through the play rather than leaving first.
  for (let i = tickers.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [tickers[i], tickers[j]] = [tickers[j]!, tickers[i]!];
  }
  return tickers.map((ticker) => STOCK_COIN_LOGOS[ticker]!);
}

/** One sampled moment of a coin's path, in viewport px (x, y is the coin centre). */
export type BeadFrame = { t: number; x: number; y: number; tiltY: number; roll: number; scale: number; opacity: number };
export type BeadFlight = {
  /** 0 = far (small, lands higher), 1 = near (large, lands lowest, slightly out of focus). */
  depth: number;
  size: number;
  blur: number;
  delay: number;
  /** Where this coin's centre meets the floor. */
  floorY: number;
  bounces: number;
  frames: BeadFrame[];
};

const easeOutCubic = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;

/**
 * Simulated paths for coins popping out of `origin`: launched up and outward, pulled down by gravity to the bottom of
 * the viewport, bouncing lower each time (restitution 0.40–0.56), losing sideways speed on each bounce, bouncing off the
 * screen's sides, then rolling to a stop. The coin wobbles (tilts back and forth, never flips, so the logo stays
 * readable) and the wobble calms down with each bounce. Pops in over 120 ms, fades out from FADE_FROM of the play.
 */
export function beadFlights(count: number, origin: Point, viewport: Viewport, rand: Rand): BeadFlight[] {
  const dt = 1 / 240;
  const sampleEvery = Math.round(SAMPLE_MS / 1000 / dt);
  const steps = Math.round(FALL_MS / 1000 / dt);
  const total = FALL_MS / 1000;
  const power = clamp(viewport.height / 900, 0.7, 1.1);
  const spread = clamp(viewport.width / 1280, 0.45, 1.1);
  return Array.from({ length: count }, (_, index) => {
    // Spread the launch angles evenly over the fan, then jitter, so no side is empty.
    const slot = (index + 0.15 + rand() * 0.7) / count;
    const angle = (-158 + slot * 136) * (Math.PI / 180);
    const depth = rand();
    const size = COIN_SIZE.far + (COIN_SIZE.near - COIN_SIZE.far) * depth;
    const blur = depth > 0.82 ? Math.round((depth - 0.82) * 90) / 10 : depth < 0.12 ? 0.6 : 0;
    const speed = (620 + 420 * rand()) * (0.85 + 0.3 * depth) * power;
    let vx = Math.cos(angle) * speed * spread * 1.15;
    let vy = Math.sin(angle) * speed;
    const half = size / 2;
    const floorY = Math.max(origin.y + 40, viewport.height - PHYSICS.floorMargin - half - (1 - depth) * PHYSICS.depthLift);
    const restitution = PHYSICS.restitution.min + (PHYSICS.restitution.max - PHYSICS.restitution.min) * rand();
    let wobble = 40 + 20 * rand();
    const omega = 7 + 5 * rand(), phase = rand() * Math.PI * 2;
    const airRoll = (rand() - 0.5) * 160;
    let x = origin.x, y = origin.y, roll = 0, bounces = 0, resting = false;
    const frames: BeadFrame[] = [];
    for (let step = 0; step <= steps; step++) {
      const t = step * dt;
      if (step % sampleEvery === 0) {
        const opacity = t < 0.05 ? t / 0.05 : t > FADE_FROM * total ? Math.max(0, 1 - (t - FADE_FROM * total) / ((1 - FADE_FROM) * total)) : 1;
        frames.push({ t, x, y, tiltY: wobble * Math.sin(omega * t + phase), roll, scale: 0.3 + 0.7 * easeOutCubic(t / 0.12),
          opacity: step === steps ? 0 : Math.round(opacity * 1000) / 1000 });
      }
      if (!resting) vy += PHYSICS.gravity * dt;
      x += vx * dt;
      y += vy * dt;
      if (y >= floorY) {
        y = floorY;
        if (vy > 0) {
          if (vy * restitution < PHYSICS.restSpeed) { vy = 0; resting = true; }
          else { vy = -vy * restitution; bounces++; }
          vx *= PHYSICS.floorFriction;
          wobble *= 0.55;
        }
      }
      // On the floor it rolls (turning with the distance it covers) and slows; in the air it turns slowly.
      if (resting) { vx *= 1 - 3 * dt; roll += ((vx * dt) / half) * (180 / Math.PI); }
      else roll += airRoll * dt;
      if (x < half) { x = half; vx = Math.abs(vx) * PHYSICS.wallBounce; }
      if (x > viewport.width - half) { x = viewport.width - half; vx = -Math.abs(vx) * PHYSICS.wallBounce; }
    }
    return { depth, size, blur, delay: Math.round(rand() * STAGGER_MS), floorY, bounces, frames };
  });
}

/**
 * Web Animations keyframes for one coin, relative to where it starts (`origin`).
 * `move` (outer layer): position, pop-in scale and opacity. `turn` (inner 3D layer): wobble and roll. Kept apart
 * because opacity below 1 flattens 3D on the element it is set on.
 */
export function beadKeyframes(flight: BeadFlight, origin: Point): {
  move: { offset: number; opacity: number; transform: string }[];
  turn: { offset: number; transform: string }[];
} {
  const total = FALL_MS / 1000;
  const offset = (t: number) => Math.min(1, Math.round((t / total) * 10000) / 10000);
  return {
    move: flight.frames.map((frame) => ({ offset: offset(frame.t), opacity: frame.opacity,
      transform: `translate3d(${(frame.x - origin.x).toFixed(1)}px, ${(frame.y - origin.y).toFixed(1)}px, 0) scale(${frame.scale.toFixed(3)})` })),
    turn: flight.frames.map((frame) => ({ offset: offset(frame.t),
      transform: `rotateY(${frame.tiltY.toFixed(1)}deg) rotateZ(${frame.roll.toFixed(1)}deg)` })),
  };
}

/** Reduced motion: a few still coins beside the origin, fading in and out where they are. */
export function reducedSpots(origin: Point, count = REDUCED_COINS): { size: number; x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (-150 + (120 * i) / Math.max(1, count - 1)) * (Math.PI / 180);
    return { size: (COIN_SIZE.far + COIN_SIZE.near) / 2, x: Math.round(origin.x + Math.cos(angle) * 80), y: Math.round(origin.y + Math.sin(angle) * 60) };
  });
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

/** The OK release plays the queued success right away (and marks it played, so closing the dialog does not repeat it). */
export function releaseCelebration(state: CelebrationTriggerState): { play: string | null; state: CelebrationTriggerState } {
  if (!state.queued || state.queued === state.lastPlayed) return { play: null, state };
  return { play: state.queued, state: { lastPlayed: state.queued, queued: null } };
}
