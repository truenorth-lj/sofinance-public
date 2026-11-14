/**
 * Compound success halo: timing, strength and geometry. Pure functions so the animation can be tested without a canvas.
 * t is the normalised time 0..1 of one play (1000 ms, or 600 ms for reduced motion).
 */

export type HaloScheme = "dark" | "light";
export type Rgb = readonly [number, number, number];

export const HALO_DURATION_MS = 1000;
export const HALO_REDUCED_DURATION_MS = 600;
/** Width of the colour ring band in CSS px. */
export const HALO_BAND_PX = 110;
/** Peak strength of the border/divider glints. */
export const HALO_GLINT_STRENGTH: Record<HaloScheme, number> = { light: 0.3, dark: 0.14 };
/** Light mode tints the page: the ring is mixed in at alpha × this. Dark mode adds light with a screen blend instead. */
export const HALO_LIGHT_TINT = 0.24;
/** Reduced motion: fades in and out in place at half strength. */
export const HALO_REDUCED_PEAK = 0.5;

/** Frost palette, outer ring colour → inner highlight. */
export const HALO_PALETTE: Record<HaloScheme, readonly [Rgb, Rgb, Rgb, Rgb]> = {
  dark: [[80, 220, 175], [70, 195, 225], [180, 240, 150], [235, 255, 245]],
  light: [[40, 190, 150], [50, 170, 210], [140, 210, 90], [180, 235, 215]],
};

const clamp01 = (value: number) => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/** Normalised time of a play that started `elapsedMs` ago. */
export function haloProgress(elapsedMs: number, durationMs: number): number {
  return durationMs > 0 ? clamp01(elapsedMs / durationMs) : 1;
}

/** Radius easing: (1 − 2^(−9t)) / (1 − 2^(−9)), 0 at t = 0 and exactly 1 at t = 1. */
export function haloEase(t: number): number {
  const x = clamp01(t);
  return (1 - 2 ** (-9 * x)) / (1 - 2 ** -9);
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

/** 0..1 weight of a point `distance` px from the origin inside the band around `radius`: (1 − x²)², 0 outside the band. */
export function haloBandWeight(distance: number, radius: number, band = HALO_BAND_PX): number {
  const x = (distance - radius) / (band / 2);
  if (!(Math.abs(x) < 1)) return 0;
  const inner = 1 - x * x;
  return inner * inner;
}

/** Final alpha of the ring colour for a scheme: light tints (× 0.24), dark adds light at full strength (screen blend). */
export function haloRingAlpha(strength: number, scheme: HaloScheme): number {
  return clamp01(strength) * (scheme === "light" ? HALO_LIGHT_TINT : 1);
}

/** Glint alpha on borders and dividers; none under reduced motion. */
export function haloGlintAlpha(strength: number, scheme: HaloScheme, reducedMotion: boolean): number {
  return reducedMotion ? 0 : clamp01(strength) * HALO_GLINT_STRENGTH[scheme];
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

/** Whether a new confirmed-success signal should (re)start the halo: once per confirmed signature, never on click. */
export function shouldPlayHalo(feedback: { phase: string; signature: string } | null, lastPlayedSignature: string | null): boolean {
  return feedback?.phase === "success" && Boolean(feedback.signature) && feedback.signature !== lastPlayedSignature;
}
