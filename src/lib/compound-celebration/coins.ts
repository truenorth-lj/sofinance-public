/**
 * Compound success celebration: when a compound is confirmed, tokenized-stock coins pop out of the Compound popup's Done
 * button (or the row's Compound button when the popup is closed) and
 * fall like beads to the bottom of the screen, bounce, settle and fade. A little pixel character runs along the bottom
 * collecting a few of them, then a big coin of the position's own stock drops on its head and it falls over.
 * Pure functions (coin choice, physics, the character's plan, timing, trigger) so it can be tested without a browser.
 */
import { MANUAL_TOKEN_ICONS } from "@/lib/token-icons/map";

/** One coin: pop out, fall, bounce, settle and fade (long enough for the character to be knocked over first). */
export const FALL_MS = 2800;
/** Fading starts at this fraction of a coin's play. */
export const FADE_FROM = 0.8;
/** Last coin leaves this long after the first. With FALL_MS, a whole number of SAMPLE_MS (so the last sample is the end). */
export const STAGGER_MS = 75;
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
/**
 * One pixel size for the whole scene, so the coins line up with the character's pixels: every sprite pixel is this many
 * CSS px (4 on a wide screen, 3 on a phone).
 */
export const SCENE_PIXEL = { wide: 4, narrow: 3 } as const;
export const scenePixel = (narrow: boolean): number => (narrow ? SCENE_PIXEL.narrow : SCENE_PIXEL.wide);

/**
 * Pixel-art coins, in the character's 2D game style and at its pixel size: a round sprite `grid` sprite pixels across
 * (outline, gold rim lit from the upper left and shaded at the lower right, and a dark face where the stock logo is
 * drawn). Depth changes how many pixels a coin has (far 14, near 18), not how big its pixels are; the coin that knocks
 * the character over is 24 across.
 */
export const COIN_GRID = { far: 14, near: 18, knock: 24 } as const;
/** Sprite pixels across for a coin at `depth` (0 far … 1 near). */
export function coinGrid(depth: number): number {
  return COIN_GRID.far + Math.round((COIN_GRID.near - COIN_GRID.far) * Math.min(1, Math.max(0, depth)));
}
/** Coin diameter in CSS px from the far plane (depth 0) to the near plane (depth 1), on a wide screen. */
export const COIN_SIZE = { far: COIN_GRID.far * SCENE_PIXEL.wide, near: COIN_GRID.near * SCENE_PIXEL.wide } as const;

/** O outline, G gold, H highlight (upper left), D shade (lower right), F the face (the stock logo), "." empty. */
export const COIN_COLORS: Readonly<Record<string, string>> = Object.freeze({ O: "#3d2b05", G: "#f2c230", H: "#fff1a6", D: "#b7861a" });
const coinSprites = new Map<number, readonly string[]>();
/** The coin sprite `grid` pixels across: a 1 px outline, a rim max(2, 14% of it) wide, the face inside. */
export function coinSprite(grid: number): readonly string[] {
  const cached = coinSprites.get(grid);
  if (cached) return cached;
  const half = grid / 2, rim = Math.max(2, Math.round(grid * 0.14));
  const rows = Object.freeze(Array.from({ length: grid }, (_, y) => Array.from({ length: grid }, (_, x) => {
    const dx = x + 0.5 - half, dy = y + 0.5 - half;
    const r = Math.hypot(dx, dy);
    if (r > half) return ".";
    if (r > half - 1) return "O";
    if (r > half - 1 - rim) { const light = (dx + dy) / grid; return light < -0.19 ? "H" : light > 0.19 ? "D" : "G"; }
    return "F";
  }).join("")));
  coinSprites.set(grid, rows);
  return rows;
}
/** The face's bounding box in sprite pixels (where the logo is drawn, clipped to the face pixels). */
export function coinFace(grid: number): { x: number; y: number; size: number } {
  const rows = coinSprite(grid);
  const top = rows.findIndex((row) => row.includes("F"));
  const left = Math.min(...rows.filter((row) => row.includes("F")).map((row) => row.indexOf("F")));
  return { x: left, y: top, size: grid - left * 2 };
}

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

/** The coin symbol for a pool token: its xStock ticker when the mint is a listed xStock, else its display symbol. */
export function coinSymbol(mint: string, symbol: string | null | undefined): string | null | undefined {
  const row = MANUAL_TOKEN_ICONS.find((item) => item.address === mint);
  return /\/logos\/tokens\/([A-Z]+)x\.png$/.exec(row?.image ?? "")?.[1] ?? symbol;
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
  /** 0 = far (small, lands higher), 1 = near (large, lands lowest). */
  depth: number;
  /** Sprite pixels across (coinGrid) and CSS px across (that × the scene pixel). */
  grid: number;
  size: number;
  blur: number;
  delay: number;
  /** Where this coin's centre meets the floor. */
  floorY: number;
  bounces: number;
  frames: BeadFrame[];
  /** Set when the character collects this coin: coin-local seconds; it vanishes from then on. */
  catchAt?: number | null;
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
  return Array.from({ length: count }, (_, index): BeadFlight => {
    // Spread the launch angles evenly over the fan, then jitter, so no side is empty.
    const slot = (index + 0.15 + rand() * 0.7) / count;
    const angle = (-158 + slot * 136) * (Math.PI / 180);
    const depth = rand();
    // Pixel art stays crisp: a whole number of CSS px per sprite pixel, and no depth blur.
    const grid = coinGrid(depth);
    const size = grid * scenePixel(viewport.width < 640);
    const blur = 0;
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
    return { depth, grid, size, blur, delay: Math.round(rand() * STAGGER_MS), floorY, bounces, frames };
  });
}

/**
 * Web Animations keyframes for one coin, relative to where it starts (`origin`).
 * `move` (outer layer): position, pop-in scale and opacity. `turn` (inner 3D layer): wobble and roll. Kept apart
 * because opacity below 1 flattens 3D on the element it is set on.
 */
export function beadKeyframes(flight: Pick<BeadFlight, "frames" | "catchAt">, origin: Point, total = FALL_MS / 1000): {
  move: { offset: number; opacity: number; transform: string }[];
  turn: { offset: number; transform: string }[];
} {
  const offset = (t: number) => Math.min(1, Math.round((t / total) * 10000) / 10000);
  // A collected coin stays where it was caught and is gone from the next frame on.
  const caught = flight.catchAt ?? null;
  const at = caught === null ? null : flight.frames.find((frame) => frame.t >= caught - 1e-9) ?? null;
  return {
    move: flight.frames.map((frame) => {
      const gone = at !== null && frame.t > at.t + 1e-9;
      const where = gone ? at : frame;
      return { offset: offset(frame.t), opacity: gone ? 0 : frame.opacity,
        transform: `translate3d(${(where.x - origin.x).toFixed(1)}px, ${(where.y - origin.y).toFixed(1)}px, 0) scale(${(gone ? 0.4 : frame.scale).toFixed(3)})` };
    }),
    turn: flight.frames.map((frame) => ({ offset: offset(frame.t),
      // A 2D game coin's spin: it narrows and widens (the wobble's cosine), never rotated off the pixel grid or flipped.
      transform: `scaleX(${Math.max(0.2, Math.cos((frame.tiltY * Math.PI) / 180)).toFixed(3)})` })),
  };
}

/** Reduced motion: a few still coins beside the origin, fading in and out where they are. */
export function reducedSpots(origin: Point, count = REDUCED_COINS): { size: number; x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (-150 + (120 * i) / Math.max(1, count - 1)) * (Math.PI / 180);
    return { size: (COIN_SIZE.far + COIN_SIZE.near) / 2, x: Math.round(origin.x + Math.cos(angle) * 80), y: Math.round(origin.y + Math.sin(angle) * 60) };
  });
}

/**
 * The confirmed success waiting for its Done (once per signature): the coins are chosen and preloaded for it, and they
 * play only when Done is clicked. Submitting, confirming, failed and nothing are never armed.
 */
export function celebrationToPlay(feedback: { phase: string; signature: string } | null, lastPlayed: string | null): string | null {
  const signature = feedback?.signature || null;
  return feedback?.phase === "success" && signature && signature !== lastPlayed ? signature : null;
}

/** The little pixel character: 24 × 28 sprite pixels, drawn at 4 px a pixel (3 on phones): 96 × 112 (72 × 84). */
export const CATCHER = Object.freeze({
  grid: { width: 24, height: 28 }, pixel: SCENE_PIXEL,
  /** Sprite pixels per second, scaled with the screen width like the coins' spread. */
  runSpeed: 540, appearMs: 150, maxCatches: 3, stepMs: 100,
  /** It is hit no earlier than this, and at least `afterCatchMs` after its last catch. */
  hitAtMs: 1700, afterCatchMs: 250, tipMs: 180,
  /** Gap between its feet and the bottom of the screen. */
  feetMargin: 6,
});
/** The big coin that knocks it over: the position's own stock, about 1.5× a near coin. */
export const KNOCK_COIN_SIZE = { wide: COIN_GRID.knock * SCENE_PIXEL.wide, narrow: COIN_GRID.knock * SCENE_PIXEL.narrow } as const;

export type CatcherPose = "stand" | "runA" | "runB";
export type CatcherFrame = { t: number; x: number; pose: CatcherPose; facing: 1 | -1; tilt: number; scale: number; opacity: number };
export type CatcherPlan = {
  pixel: number; width: number; height: number;
  /** Where its feet stand (viewport px), and where it first appears. */
  feetY: number; startX: number;
  /** Which coins it collects (index into the flights) and when (seconds after the play starts). */
  catches: { coin: number; t: number; x: number }[];
  hitT: number;
  frames: CatcherFrame[];
  /** The coin that hits it: drops from above the screen onto its head, bounces off, lands, fades. */
  knock: { grid: number; size: number; frames: BeadFrame[] };
};

/**
 * Plans the character against the coins' simulated paths (which it updates with `catchAt` for the coins it collects).
 * It appears under `origin`, runs (at most `runSpeed`) to where a coin first touches the floor and collects it as it
 * lands, up to `maxCatches`, then stands still; a big coin dropped from above hits its head at `hitT` and it tips over
 * backwards (−90° over `tipMs`) and lies there until everything fades.
 */
export function planCatcher(flights: BeadFlight[], origin: Point, viewport: Viewport, rand: Rand): CatcherPlan {
  const pixel = viewport.width < 640 ? CATCHER.pixel.narrow : CATCHER.pixel.wide;
  const width = CATCHER.grid.width * pixel, height = CATCHER.grid.height * pixel;
  const feetY = viewport.height - CATCHER.feetMargin;
  const speed = CATCHER.runSpeed * clamp(viewport.width / 1280, 0.55, 1.1);
  const total = (STAGGER_MS + FALL_MS) / 1000;
  const appear = CATCHER.appearMs / 1000;
  const size = viewport.width < 640 ? KNOCK_COIN_SIZE.narrow : KNOCK_COIN_SIZE.wide;
  // Never closer to a side than the knock coin's half width, so that coin can always land centred on its head.
  const edge = Math.max(width, size) / 2;
  const startX = clamp(origin.x, edge, viewport.width - edge);
  type Move = { t0: number; t1: number; x0: number; x1: number };
  const moves: Move[] = [];
  const catches: CatcherPlan["catches"] = [];
  let x = startX, free = appear;
  const landings = flights.map((flight, coin) => {
    const first = flight.frames.find((frame) => frame.y >= flight.floorY - 0.01);
    return first ? { coin, t: first.t + flight.delay / 1000, x: first.x } : null;
  }).filter((landing): landing is { coin: number; t: number; x: number } => landing !== null).sort((a, b) => a.t - b.t);
  const latestCatch = CATCHER.hitAtMs / 1000 - CATCHER.afterCatchMs / 1000;
  for (const landing of landings) {
    if (catches.length >= CATCHER.maxCatches || landing.t > latestCatch) break;
    const target = clamp(landing.x, edge, viewport.width - edge);
    const need = Math.abs(target - x) / speed;
    if (landing.t < free || need > landing.t - free) continue;
    if (need > 0) moves.push({ t0: free, t1: free + need, x0: x, x1: target });
    catches.push({ coin: landing.coin, t: landing.t, x: target });
    flights[landing.coin]!.catchAt = landing.t - flights[landing.coin]!.delay / 1000;
    x = target;
    free = landing.t;
  }
  const hitT = Math.max(CATCHER.hitAtMs / 1000, free + CATCHER.afterCatchMs / 1000);
  // The knock coin: falls from above the screen to its head, bounces off away from the nearer wall, lands, fades.
  const headY = feetY - height - size / 2 + pixel;
  const drop = headY + size;
  const fall = Math.sqrt((2 * drop) / PHYSICS.gravity);
  const spawn = hitT - fall;
  const knockFloor = viewport.height - PHYSICS.floorMargin - size / 2;
  const away = x < viewport.width / 2 ? 1 : -1;
  const dt = 1 / 240, sampleEvery = Math.round(SAMPLE_MS / 1000 / dt), steps = Math.round(total / dt);
  const knockFrames: BeadFrame[] = [];
  let kx = x, ky = -size, kvx = 0, kvy = 0, kroll = 0, hit = false, resting = false;
  const fadeFrom = FADE_FROM * total;
  const fadeOut = (t: number) => (t > fadeFrom ? Math.max(0, 1 - (t - fadeFrom) / (total - fadeFrom)) : 1);
  for (let step = 0; step <= steps; step++) {
    const t = step * dt;
    if (step % sampleEvery === 0) {
      knockFrames.push({ t, x: kx, y: ky, tiltY: hit ? 0 : 18 * Math.sin(9 * t), roll: kroll, scale: 1,
        opacity: t < spawn ? 0 : step === steps ? 0 : Math.round(fadeOut(t) * 1000) / 1000 });
    }
    if (t < spawn) continue;
    if (!resting) kvy += PHYSICS.gravity * dt;
    kx += kvx * dt; ky += kvy * dt;
    if (!hit && ky >= headY) { ky = headY; kvy = -kvy * 0.42; kvx = away * (160 + 80 * rand()); hit = true; }
    if (hit && ky >= knockFloor && kvy > 0) {
      ky = knockFloor;
      if (kvy * 0.45 < PHYSICS.restSpeed) { kvy = 0; resting = true; } else kvy = -kvy * 0.45;
      kvx *= PHYSICS.floorFriction;
    }
    if (resting) { kvx *= 1 - 3 * dt; kroll += ((kvx * dt) / (size / 2)) * (180 / Math.PI); }
    if (kx < size / 2) { kx = size / 2; kvx = Math.abs(kvx) * PHYSICS.wallBounce; }
    if (kx > viewport.width - size / 2) { kx = viewport.width - size / 2; kvx = -Math.abs(kvx) * PHYSICS.wallBounce; }
  }
  // The character's own frames, every SAMPLE_MS.
  const frames: CatcherFrame[] = [];
  let facing: 1 | -1 = 1;
  const sampleCount = Math.round(total / (SAMPLE_MS / 1000));
  for (let i = 0; i <= sampleCount; i++) {
    const t = (i * SAMPLE_MS) / 1000;
    const move = moves.find((m) => t >= m.t0 && t < m.t1) ?? null;
    let at = startX;
    for (const m of moves) at = t >= m.t1 ? m.x1 : t > m.t0 ? m.x0 + (m.x1 - m.x0) * ((t - m.t0) / (m.t1 - m.t0)) : at;
    if (move) facing = move.x1 >= move.x0 ? 1 : -1;
    const pose: CatcherPose = move && t < hitT ? (Math.floor(((t - move.t0) * 1000) / CATCHER.stepMs) % 2 === 0 ? "runA" : "runB") : "stand";
    const tip = t <= hitT ? 0 : Math.min(1, (t - hitT) / (CATCHER.tipMs / 1000));
    frames.push({ t, x: at, pose, facing, tilt: Math.round(-90 * easeOutCubic(tip) * 10) / 10,
      scale: Math.round(easeOutCubic(t / appear) * 1000) / 1000,
      opacity: i === sampleCount ? 0 : Math.round(Math.min(1, t / (appear / 2)) * fadeOut(t) * 1000) / 1000 });
  }
  return { pixel, width, height, feetY, startX, catches, hitT, frames, knock: { grid: COIN_GRID.knock, size, frames: knockFrames } };
}

/** Web Animations keyframes for the character (relative to where it first appears). */
export function catcherKeyframes(plan: CatcherPlan): {
  move: { offset: number; opacity: number; transform: string }[];
  tilt: { offset: number; transform: string }[];
  poses: Record<CatcherPose, { offset: number; opacity: number; easing: string }[]>;
} {
  const total = plan.frames.at(-1)!.t;
  const offset = (t: number) => Math.min(1, Math.round((t / total) * 10000) / 10000);
  const pose = (name: CatcherPose) => plan.frames.map((frame) => ({ offset: offset(frame.t), opacity: frame.pose === name ? 1 : 0, easing: "step-end" }));
  return {
    move: plan.frames.map((frame) => ({ offset: offset(frame.t), opacity: frame.opacity,
      transform: `translate3d(${(frame.x - plan.startX).toFixed(1)}px, 0, 0) scale(${frame.facing * frame.scale}, ${frame.scale})` })),
    // It tips over around its feet, rising by half its width as it goes so it ends up lying on the floor, not through it.
    tilt: plan.frames.map((frame) => ({ offset: offset(frame.t),
      transform: `translateY(${((frame.tilt / 90) * (plan.width / 2)).toFixed(1)}px) rotate(${frame.tilt}deg)` })),
    poses: { stand: pose("stand"), runA: pose("runA"), runB: pose("runB") },
  };
}

/**
 * The character's sprites, one row per string, 24 × 28 (original pixel art in the app's colours): O outline, Y lemon
 * hoodie, L its highlight, y its shade, K the face in the hood's shadow, W eyes and drawstrings, E the eyes' shine,
 * C hands, N trousers, n their shade, B shoes, b soles, "." empty. Generated once (a hood, a face opening, a torso with a
 * pocket, arms a pixel apart from it, legs), then outlined; kept here as data.
 */
export const CATCHER_COLORS: Readonly<Record<string, string>> = Object.freeze({
  O: "#2a250c", Y: "#f3e76b", L: "#fff6b0", y: "#c9bd45", K: "#0d0d0c", W: "#f4f0e6", E: "#ffffff",
  C: "#f4d9b8", N: "#3a4a8c", n: "#2a3668", B: "#98948b", b: "#5f5c55",
});
export const CATCHER_SPRITES: Readonly<Record<CatcherPose, readonly string[]>> = Object.freeze({
  stand: [
    ".........OOOOOO.........",
    ".......OOYYYYYYOO.......",
    "......OYLLYYYYYYyO......",
    ".....OYLLYYYYYYYyyO.....",
    "....OYLLYYYYYYYYyyyO....",
    "....OYLYYYYKKYYYyyyO....",
    "....OYYYYKKKKKKYyyyO....",
    "...OYYYYKKKKKKKKyyyyO...",
    "...OYYYKKEWKKKEWKyyyO...",
    "....OYYKKWWKKKWWKyyO....",
    "....OYYYKKKKKKKKyyyO....",
    "....OYYYYKKKKKKYyyyO....",
    ".....OYYYYYKKYYYyyO.....",
    "......OYYYYYYYYYyO......",
    "...OOO.OYYYYYYYYO.OOO...",
    "..OYYYOYYYWYYWYyyOYYyO..",
    "..OYYYOYYYWYYWYyyOYYyO..",
    "..OYYYOYYYWYYWYyyOYYyO..",
    "..OYYYOYYYYYYYYyyOYYyO..",
    "..OYYYOYyyyyyyyyyOYYyO..",
    "..OyyyOYyYYYYYYyyOyyyO..",
    "..OCCCOYyYYYYYYyyOCCCO..",
    "..OCCCOyyyyyyyyyyOCCCO..",
    "...OOO.ONNNNONNnO.OOO...",
    ".......ONNNNONNnO.......",
    ".......ONNNNONNnOO......",
    "......OBBBBBOBBBBBO.....",
    "......ObbbbbObbbbbO.....",
  ],
  runA: [
    ".........OOOOOO.........",
    ".......OOYYYYYYOO.......",
    "......OYLLYYYYYYyO......",
    ".....OYLLYYYYYYYyyO.....",
    "....OYLLYYYYYYYYyyyO....",
    "....OYLYYYYKKYYYyyyO....",
    "....OYYYYKKKKKKYyyyO....",
    "...OYYYYKKKKKKKKyyyyO...",
    "...OYYYKKEWKKKEWKyyyO...",
    "....OYYKKWWKKKWWKyyO....",
    "....OYYYKKKKKKKKyyyO....",
    "....OYYYYKKKKKKYyyyO....",
    "...OOOYYYYYKKYYYyyO.....",
    "..OYYYOYYYYYYYYYyO......",
    "..OYYYOOYYYYYYYYO.......",
    "..OYYYOYYYWYYWYyyOOOO...",
    "..OYYYOYYYWYYWYyyOYYyO..",
    "..OYYYOYYYWYYWYyyOYYyO..",
    "..OyyyOYYYYYYYYyyOYYyO..",
    "..OCCCOYyyyyyyyyyOYYyO..",
    "..OCCCOYyYYYYYYyyOYYyO..",
    "...OOOOYyYYYYYYyyOyyyO..",
    "......OyyyyyyyyyyOCCCO..",
    "......ONNNNOOnnnnOCCCO..",
    ".....OONNNNOOnnnnOOOO...",
    "...OONNNNOO..OOnnnnOO...",
    "..OBBBBBO......OBBBBBO..",
    "..ObbbbbO......ObbbbbO..",
  ],
  runB: [
    ".........OOOOOO.........",
    ".......OOYYYYYYOO.......",
    "......OYLLYYYYYYyO......",
    ".....OYLLYYYYYYYyyO.....",
    "....OYLLYYYYYYYYyyyO....",
    "....OYLYYYYKKYYYyyyO....",
    "....OYYYYKKKKKKYyyyO....",
    "...OYYYYKKKKKKKKyyyyO...",
    "...OYYYKKEWKKKEWKyyyO...",
    "....OYYKKWWKKKWWKyyO....",
    "....OYYYKKKKKKKKyyyO....",
    "....OYYYYKKKKKKYyyyO....",
    ".....OYYYYYKKYYYyyOOO...",
    "......OYYYYYYYYYyOYYyO..",
    ".......OYYYYYYYYOOYYyO..",
    "...OOOOYYYWYYWYyyOYYyO..",
    "..OYYYOYYYWYYWYyyOYYyO..",
    "..OYYYOYYYWYYWYyyOYYyO..",
    "..OYYYOYYYYYYYYyyOyyyO..",
    "..OYYYOYyyyyyyyyyOCCCO..",
    "..OYYYOYyYYYYYYyyOCCCO..",
    "..OyyyOYyYYYYYYyyOOOO...",
    "..OCCCOyyyyyyyyyyO......",
    "..OCCCOOONNNNnnOO.......",
    "...OOO..ONNNNnnO........",
    ".........ONNNNO.........",
    "........OBBBBBBO........",
    "........ObbbbbbO........",
  ],
});

/** Sprite rows as runs of same-coloured pixels (fewer SVG rects than one per pixel). */
export function spriteRuns(rows: readonly string[], colors: Readonly<Record<string, string>> = CATCHER_COLORS): { x: number; y: number; width: number; color: string }[] {
  const runs: { x: number; y: number; width: number; color: string }[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const key = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === key) end++;
      const color = colors[key];
      if (color) runs.push({ x, y, width: end - x, color });
      x = end;
    }
  });
  return runs;
}
