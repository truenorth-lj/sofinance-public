/**
 * Compound success halo: timing, strength and geometry. Pure functions so the animation can be tested without a canvas.
 * t is the normalised time 0..1 of one play (1200 ms, or 600 ms for reduced motion).
 */

export type HaloScheme = "dark" | "light";
export type Rgb = readonly [number, number, number];

export const HALO_DURATION_MS = 1200;
export const HALO_REDUCED_DURATION_MS = 600;
/** Width of the colour ring band in CSS px. */
export const HALO_BAND_PX = 150;
/** Peak strength of the border/divider glints. */
export const HALO_GLINT_STRENGTH: Record<HaloScheme, number> = { light: 0.4, dark: 0.24 };
/** Light mode tints the page: the ring is mixed in at alpha × this. Dark mode adds light with a screen blend instead. */
export const HALO_LIGHT_TINT = 0.3;
/** Reduced motion: fades in and out in place at half strength. */
export const HALO_REDUCED_PEAK = 0.5;
/** Ease exponent of the opening punch (higher is a sharper launch). */
export const HALO_EASE_K = 16;
/** Opening punch: this fraction of the play covers this fraction of the travel; the rest coasts. */
export const HALO_PUNCH_T = 0.18;
export const HALO_PUNCH_TRAVEL = 0.42;
/** Trailing wave starts this fraction of the play after the front wave. */
export const HALO_TRAIL_DELAY = 0.15;
/** Trailing wave peak, relative to the front wave. */
export const HALO_TRAIL_STRENGTH = 0.55;
/** Screen-shake window: two short kicks, then settle; never longer than this. */
export const HALO_SHAKE_MS = 150;
/** Peak translation of a kick, in CSS px. */
export const HALO_SHAKE_PX = 3;

/** Frost palette, outer ring colour → inner highlight. */
export const HALO_PALETTE: Record<HaloScheme, readonly [Rgb, Rgb, Rgb, Rgb]> = {
  dark: [[90, 235, 190], [80, 215, 245], [200, 255, 165], [245, 255, 250]],
  light: [[40, 190, 150], [50, 170, 210], [140, 210, 90], [180, 235, 215]],
};

const clamp01 = (value: number) => (value <= 0 ? 0 : value >= 1 ? 1 : value);
const clamp = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value);

/** Normalised time of a play that started `elapsedMs` ago. */
export function haloProgress(elapsedMs: number, durationMs: number): number {
  return durationMs > 0 ? clamp01(elapsedMs / durationMs) : 1;
}

/**
 * Radius easing: a sharp exponential punch over the first HALO_PUNCH_T of the play (covering
 * HALO_PUNCH_TRAVEL of the reach), then a linear coast so the ring is still on-screen late in the 1200 ms play.
 * 0 at t = 0 and exactly 1 at t = 1.
 */
export function haloEase(t: number, k = HALO_EASE_K): number {
  const x = clamp01(t);
  if (x <= HALO_PUNCH_T) {
    const u = x / HALO_PUNCH_T;
    return HALO_PUNCH_TRAVEL * (1 - 2 ** (-k * u)) / (1 - 2 ** -k);
  }
  const u = (x - HALO_PUNCH_T) / (1 - HALO_PUNCH_T);
  return HALO_PUNCH_TRAVEL + (1 - HALO_PUNCH_TRAVEL) * u;
}

/** Ring strength: a 3%-of-the-play attack, then (1 − t^2.2) decay to 0 at t = 1. */
export function haloStrength(t: number): number {
  const x = clamp01(t);
  return Math.min(1, x / 0.03) * (1 - x ** 2.2);
}

/** Reduced-motion strength: fades in and back out in place, peaking at half strength mid-play. */
export function haloReducedStrength(t: number): number {
  return HALO_REDUCED_PEAK * Math.sin(Math.PI * clamp01(t));
}

/** How far the ring travels: from the origin to just past the surface's farthest corner (the band fully leaves it). */
export function haloReach(origin: { x: number; y: number }, size: { width: number; height: number }, band = HALO_BAND_PX): number {
  const dx = Math.max(origin.x, size.width - origin.x);
  const dy = Math.max(origin.y, size.height - origin.y);
  return Math.hypot(dx, dy) + band / 2;
}

/** Ring radius at time t. */
export function haloRadius(t: number, reach: number): number {
  return haloEase(t) * reach;
}

/**
 * Normalised time of the trailing wave: 0 until `delay`, then the same 0..1 ease window over the remainder.
 * A delay of 0 is the front wave.
 */
export function haloTrailTime(t: number, delay = HALO_TRAIL_DELAY): number {
  const x = clamp01(t);
  if (delay <= 0) return x;
  if (delay >= 1) return 0;
  return x <= delay ? 0 : (x - delay) / (1 - delay);
}

/** Trailing-wave strength: the usual envelope, scaled down, silent before the delay. */
export function haloTrailStrength(t: number, delay = HALO_TRAIL_DELAY, scale = HALO_TRAIL_STRENGTH): number {
  const trail = haloTrailTime(t, delay);
  return trail <= 0 ? 0 : scale * haloStrength(trail);
}

/** 0..1 weight of a point `distance` px from the origin inside the band around `radius`: (1 − x²)², 0 outside the band. */
export function haloBandWeight(distance: number, radius: number, band = HALO_BAND_PX): number {
  const x = (distance - radius) / (band / 2);
  if (!(Math.abs(x) < 1)) return 0;
  const inner = 1 - x * x;
  return inner * inner;
}

/** Final alpha of the ring colour for a scheme: light tints (× 0.3), dark adds light at full strength (screen blend). */
export function haloRingAlpha(strength: number, scheme: HaloScheme): number {
  return clamp01(strength) * (scheme === "light" ? HALO_LIGHT_TINT : 1);
}

/** Glint alpha on borders and dividers; none under reduced motion. */
export function haloGlintAlpha(strength: number, scheme: HaloScheme, reducedMotion: boolean): number {
  return reducedMotion ? 0 : clamp01(strength) * HALO_GLINT_STRENGTH[scheme];
}

/**
 * A very short screen shake: two kicks of at most HALO_SHAKE_PX, then settle, all within HALO_SHAKE_MS.
 * Reduced motion never shakes.
 */
export function haloShake(elapsedMs: number, reducedMotion = false): { x: number; y: number } {
  if (reducedMotion || elapsedMs < 0 || elapsedMs >= HALO_SHAKE_MS) return { x: 0, y: 0 };
  if (elapsedMs < 50) return { x: HALO_SHAKE_PX, y: -2 };
  if (elapsedMs < 100) return { x: -2, y: 2 };
  return { x: 0, y: 0 };
}

/** WCAG relative luminance of an sRGB colour (0..1); used to pick the light or dark treatment from the page. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function schemeForBackground(background: Rgb): HaloScheme {
  return relativeLuminance(background) > 0.5 ? "light" : "dark";
}

/** Parses `rgb(r g b)`, `rgb(r, g, b)` or `rgba(…)` from getComputedStyle; null when transparent or unparsable. */
export function parseOpaqueRgb(value: string): Rgb | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (!match) return null;
  const alphaText = match[4];
  const alpha = alphaText === undefined ? 1 : alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  if (!(alpha >= 0.5)) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export type HaloTriggerState = { lastPlayed: string | null; queued: string | null };

/**
 * Advances the trigger state. A confirmed success is queued once per signature. It plays immediately when nothing is
 * holding the result (no app dialog open), or only after that hold is released. Closing a dialog that is not a
 * confirmed success never plays. `held` is true while an app dialog is still open.
 */
export function nextHaloTrigger(
  feedback: { phase: string; signature: string } | null,
  held: boolean,
  state: HaloTriggerState,
): { play: boolean; state: HaloTriggerState } {
  let { lastPlayed, queued } = state;
  const phase = feedback?.phase ?? null;
  const signature = feedback?.signature || null;
  if (phase === "success" && signature && signature !== lastPlayed) queued = signature;
  else if (phase && phase !== "success" && signature && signature === queued) queued = null;
  const play = Boolean(queued && queued !== lastPlayed && !held);
  if (play) {
    lastPlayed = queued;
    queued = null;
  }
  return { play, state: { lastPlayed, queued } };
}

/** Whether a new confirmed-success signal should (re)start the halo immediately (no dialog holding it). */
export function shouldPlayHalo(feedback: { phase: string; signature: string } | null, lastPlayedSignature: string | null, held = false): boolean {
  return nextHaloTrigger(feedback, held, { lastPlayed: lastPlayedSignature, queued: null }).play;
}

/**
 * Origin of the ring, in visible-slice coordinates, measured after any result dialog has closed.
 * A missing button falls back to the slice centre. A button scrolled out of view is clamped to the slice edge
 * in that direction, so the wave still enters from where the button went.
 */
export function haloOriginPoint(
  button: { left: number; top: number; width: number; height: number } | null,
  frame: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  if (!button || !(button.width > 0) || !(button.height > 0)) {
    return { x: frame.width / 2, y: frame.height / 2 };
  }
  const x = button.left + button.width / 2 - frame.left;
  const y = button.top + button.height / 2 - frame.top;
  const right = button.left + button.width, bottom = button.top + button.height;
  const frameRight = frame.left + frame.width, frameBottom = frame.top + frame.height;
  const visible = right > frame.left && bottom > frame.top && button.left < frameRight && button.top < frameBottom;
  if (visible) return { x, y };
  return { x: clamp(x, 0, frame.width), y: clamp(y, 0, frame.height) };
}

/** Device-pixel cap for the halo canvases: sharp on retina, bounded memory on 3× phones. */
export const HALO_MAX_DPR = 2;
export function haloCanvasScale(devicePixelRatio: number | undefined): number {
  const dpr = devicePixelRatio && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, HALO_MAX_DPR);
}

export type HaloSlice = { x: number; y: number; width: number; height: number };

/**
 * The part of the content area the user can see (content area ∩ viewport), in content-area coordinates. The halo's
 * canvases cover only this slice, and the ring travels to just past its farthest corner.
 */
export function haloVisibleSlice(surface: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number }): HaloSlice {
  const left = Math.max(surface.left, 0), top = Math.max(surface.top, 0);
  const right = Math.min(surface.left + surface.width, viewport.width), bottom = Math.min(surface.top + surface.height, viewport.height);
  return { x: left - surface.left, y: top - surface.top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
