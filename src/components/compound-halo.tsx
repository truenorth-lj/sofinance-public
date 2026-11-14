"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  HALO_BAND_PX, HALO_DURATION_MS, HALO_PALETTE, HALO_REDUCED_DURATION_MS, haloCanvasScale, haloGlintAlpha, haloOriginPoint,
  haloProgress, haloRadius, haloReach, haloReducedStrength, haloRingAlpha, haloShake, haloStrength, haloTrailStrength,
  haloTrailTime, haloVisibleSlice, nextHaloTrigger, parseOpaqueRgb, schemeForBackground,
  type HaloScheme, type HaloSlice, type HaloTriggerState, type Rgb,
} from "@/lib/compound-halo/math";

/** The page content area the halo is clipped to (below the top nav). Falls back to the Compound panel's own section. */
export const HALO_SURFACE_ATTR = "data-halo-surface";
/** Visual-only preview hook for screenshots and tests: `window.dispatchEvent(new Event(HALO_PREVIEW_EVENT))`. */
export const HALO_PREVIEW_EVENT = "sofinance:compound-halo-preview";

/**
 * The preview hook is off in production builds. It is on in `next dev` and tests (NODE_ENV is not "production"), and in
 * a production build only when built with NEXT_PUBLIC_HALO_PREVIEW=1 (local screenshot builds; never set on Vercel).
 */
export function haloPreviewEnabled(env: { NODE_ENV?: string; NEXT_PUBLIC_HALO_PREVIEW?: string } = {
  NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_HALO_PREVIEW: process.env.NEXT_PUBLIC_HALO_PREVIEW,
}): boolean {
  return env.NODE_ENV !== "production" || env.NEXT_PUBLIC_HALO_PREVIEW === "1";
}

type Feedback = { phase: string; signature: string } | null;

/**
 * Plays the halo once a compound transaction is CONFIRMED successful, and only after any app result dialog for that
 * send has been closed. `held` is true while that dialog is still open. Clicking Compound never plays it. Returns a
 * counter that changes on every play; a new play while one runs restarts it. Once per signature.
 */
export function useCompoundSuccessHalo(feedback: Feedback, held = false): number {
  const trigger = useRef<HaloTriggerState>({ lastPlayed: null, queued: null });
  const [play, setPlay] = useState(0);
  const phase = feedback?.phase ?? null;
  const signature = feedback?.signature ?? null;
  useEffect(() => {
    const current = phase && signature ? { phase, signature } : null;
    const next = nextHaloTrigger(current, held, trigger.current);
    trigger.current = next.state;
    if (next.play) setPlay((count) => count + 1);
  }, [phase, signature, held]);
  useEffect(() => {
    if (!haloPreviewEnabled()) return;
    const preview = () => setPlay((count) => count + 1);
    window.addEventListener(HALO_PREVIEW_EVENT, preview);
    return () => window.removeEventListener(HALO_PREVIEW_EVENT, preview);
  }, []);
  return play;
}

type Edge = { kind: "box"; x: number; y: number; width: number; height: number; radius: number; line: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; line: number };

const visibleBorder = (style: CSSStyleDeclaration, side: "Top" | "Right" | "Bottom" | "Left") =>
  parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none" && !/^rgba?\(.*,\s*0\)$|transparent/.test(style[`border${side}Color`]);

export type HaloFrame = { left: number; top: number; width: number; height: number };
const outside = (rect: DOMRect, frame: HaloFrame) =>
  rect.right < frame.left || rect.bottom < frame.top || rect.left > frame.left + frame.width || rect.top > frame.top + frame.height;

/** Borders and dividers in the visible slice, in slice coordinates. Text and icons are never collected. */
function collectEdges(surface: HTMLElement, origin: HaloFrame): Edge[] {
  const edges: Edge[] = [];
  for (const element of surface.querySelectorAll<HTMLElement>("*")) {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const sides = (["Top", "Right", "Bottom", "Left"] as const).filter((side) => visibleBorder(style, side));
    if (!sides.length) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || outside(rect, origin)) continue;
    const x = rect.left - origin.left, y = rect.top - origin.top;
    const line = Math.max(1, parseFloat(style.borderTopWidth) || parseFloat(style.borderLeftWidth) || 1);
    if (sides.length === 4) {
      edges.push({ kind: "box", x, y, width: rect.width, height: rect.height, line,
        radius: Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.width / 2, rect.height / 2) });
      continue;
    }
    for (const side of sides) {
      const width = parseFloat(style[`border${side}Width`]);
      if (side === "Top") edges.push({ kind: "line", x1: x, y1: y + width / 2, x2: x + rect.width, y2: y + width / 2, line: width });
      if (side === "Bottom") edges.push({ kind: "line", x1: x, y1: y + rect.height - width / 2, x2: x + rect.width, y2: y + rect.height - width / 2, line: width });
      if (side === "Left") edges.push({ kind: "line", x1: x + width / 2, y1: y, x2: x + width / 2, y2: y + rect.height, line: width });
      if (side === "Right") edges.push({ kind: "line", x1: x + rect.width - width / 2, y1: y, x2: x + rect.width - width / 2, y2: y + rect.height, line: width });
    }
  }
  return edges;
}

/** Light or dark treatment from the first opaque background behind the surface. */
function resolveScheme(surface: HTMLElement): HaloScheme {
  for (let node: HTMLElement | null = surface; node; node = node.parentElement) {
    const rgb = parseOpaqueRgb(getComputedStyle(node).backgroundColor);
    if (rgb) return schemeForBackground(rgb);
  }
  return getComputedStyle(document.documentElement).colorScheme.includes("light") ? "light" : "dark";
}

const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(4)})`;

/** Draws an inline SVG into the mask by its own shape: a copy with every painted fill and stroke forced to solid black. */
function solidSvgImage(svg: SVGSVGElement, rect: DOMRect): Promise<HTMLImageElement | null> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll<SVGElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<SVGElement>("*")];
  originals.forEach((original, index) => {
    const target = copies[index];
    if (!target) return;
    const style = getComputedStyle(original);
    target.setAttribute("fill", style.fill && style.fill !== "none" ? "#000" : "none");
    target.setAttribute("stroke", style.stroke && style.stroke !== "none" ? "#000" : "none");
    if (style.strokeWidth) target.setAttribute("stroke-width", style.strokeWidth);
    target.removeAttribute("class"); target.removeAttribute("style");
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(rect.width)); copy.setAttribute("height", String(rect.height));
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  return image.decode().then(() => image, () => null);
}

/**
 * The glyph and icon mask, not a page image: text glyphs, inline SVG icons by their shape and raster images by their
 * own alpha (clipped to their corner radius) are painted into an offscreen transparency mask over the visible slice.
 * Those pixels are cut out of the light layer, so text and icons never light up. No bounding boxes are filled.
 */
/** Screen-reader-only text (sr-only: clipped to a 1 px box) paints nothing, so it must not be cut out of the light. */
function visuallyHidden(element: Element, surface: HTMLElement, seen: Map<Element, boolean>): boolean {
  const cached = seen.get(element);
  if (cached !== undefined) return cached;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const hidden = style.display === "none" || style.visibility === "hidden" || (!!style.opacity && Number(style.opacity) === 0)
    || (!!style.clip && style.clip !== "auto") || (!!style.clipPath && style.clipPath !== "none")
    || (!!style.overflow && style.overflow !== "visible" && (rect.width <= 1 || rect.height <= 1))
    || (element !== surface && !!element.parentElement && visuallyHidden(element.parentElement, surface, seen));
  seen.set(element, hidden);
  return hidden;
}

export async function buildHaloMask(surface: HTMLElement, frame: HaloFrame, scale: number): Promise<HTMLCanvasElement | null> {
  const mask = document.createElement("canvas");
  mask.width = Math.ceil(frame.width * scale); mask.height = Math.ceil(frame.height * scale);
  const context = mask.getContext("2d");
  if (!context) return null;
  context.scale(scale, scale); context.fillStyle = "#000"; context.textBaseline = "alphabetic";
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  const range = document.createRange();
  const hidden = new Map<Element, boolean>();
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || parent.closest("canvas,script,style,svg,option")) continue;
    if (outside(parent.getBoundingClientRect(), frame)) continue;
    if (visuallyHidden(parent, surface, hidden)) continue;
    const style = getComputedStyle(parent);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = node.textContent;
    for (let i = 0; i < text.length; i++) {
      const char = text.charAt(i);
      if (!char.trim()) continue;
      range.setStart(node, i); range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const metrics = context.measureText(char);
      const ascent = metrics.fontBoundingBoxAscent ?? parseFloat(style.fontSize) * 0.8;
      const descent = metrics.fontBoundingBoxDescent ?? parseFloat(style.fontSize) * 0.2;
      // The DOM text range's height is the font box (not CSS line-height); centre that font box on its baseline.
      const baseline = rect.top - frame.top + (rect.height + ascent - descent) / 2;
      context.fillText(char, rect.left - frame.left, baseline);
    }
  }
  range.detach();
  // A <select> paints its chosen option itself (no DOM text node to range over): cut that label out at its padding box.
  for (const select of surface.querySelectorAll<HTMLSelectElement>("select")) {
    const label = select.selectedOptions[0]?.text.trim();
    const rect = select.getBoundingClientRect();
    if (!label || !rect.width || !rect.height || outside(rect, frame) || visuallyHidden(select, surface, hidden)) continue;
    const style = getComputedStyle(select);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = context.measureText(label);
    const ascent = metrics.fontBoundingBoxAscent ?? parseFloat(style.fontSize) * 0.8;
    const descent = metrics.fontBoundingBoxDescent ?? parseFloat(style.fontSize) * 0.2;
    // The control centres its font box in the content box; put the baseline where that box's baseline lands.
    const top = rect.top - frame.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
    const inner = rect.height - (parseFloat(style.borderTopWidth) || 0) - (parseFloat(style.borderBottomWidth) || 0)
      - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
    context.fillText(label, rect.left - frame.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0),
      Math.floor(top + (inner + ascent - descent) / 2)); // the control snaps its baseline to whole pixels
  }
  const icons: Promise<void>[] = [];
  for (const svg of surface.querySelectorAll<SVGSVGElement>("svg")) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height || outside(rect, frame) || svg.closest("[aria-hidden='true'][data-testid='compound-halo']")) continue;
    icons.push(solidSvgImage(svg, rect).then((image) => {
      if (image) context.drawImage(image, rect.left - frame.left, rect.top - frame.top, rect.width, rect.height);
    }));
  }
  for (const image of surface.querySelectorAll<HTMLImageElement>("img")) {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height || outside(rect, frame) || !image.complete || !image.naturalWidth) continue;
    const radius = Math.min(parseFloat(getComputedStyle(image).borderTopLeftRadius) || 0, rect.width / 2, rect.height / 2);
    context.save();
    context.beginPath(); context.roundRect(rect.left - frame.left, rect.top - frame.top, rect.width, rect.height, radius); context.clip();
    context.drawImage(image, rect.left - frame.left, rect.top - frame.top, rect.width, rect.height);
    context.restore();
  }
  await Promise.all(icons);
  return mask;
}

type Run = { surface: HTMLElement; scheme: HaloScheme; reduced: boolean; radius: string; slice: HaloSlice;
  origin: { x: number; y: number }; edges: Edge[] };

function protectTextAndIcons(context: CanvasRenderingContext2D, mask: HTMLCanvasElement | null, run: Run) {
  if (!mask) return;
  context.save(); context.globalCompositeOperation = "destination-out";
  context.drawImage(mask, 0, 0, run.slice.width, run.slice.height);
  context.restore();
}

function paintRing(context: CanvasRenderingContext2D, run: Run, t: number, strength: number, band: number, glints: boolean) {
  if (strength <= 0 || t <= 0) return;
  const { origin, scheme } = run;
  const { width, height } = run.slice;
  const palette = HALO_PALETTE[scheme];
  const reach = haloReach(origin, { width, height }, band);
  const radius = haloRadius(t, reach);
  const half = band / 2;
  const inner = Math.max(0, radius - half), outer = radius + half;
  if (outer <= 0) return;
  const at = (distance: number) => Math.max(0, Math.min(1, (distance - inner) / (outer - inner)));
  const ringAlpha = haloRingAlpha(strength, scheme);
  const ring = context.createRadialGradient(origin.x, origin.y, inner, origin.x, origin.y, outer);
  ring.addColorStop(0, rgba(palette[2], 0));
  ring.addColorStop(at(radius - half * 0.55), rgba(palette[2], ringAlpha * 0.55));
  ring.addColorStop(at(radius - half * 0.18), rgba(palette[0], ringAlpha));
  ring.addColorStop(at(radius + half * 0.08), rgba(palette[3], ringAlpha));
  ring.addColorStop(at(radius + half * 0.48), rgba(palette[1], ringAlpha * 0.55));
  ring.addColorStop(1, rgba(palette[1], 0));
  context.fillStyle = ring;
  context.fillRect(0, 0, width, height);
  if (!glints) return;
  const glintAlpha = haloGlintAlpha(strength, scheme, run.reduced);
  if (!glintAlpha || !run.edges.length) return;
  const glint = context.createRadialGradient(origin.x, origin.y, inner, origin.x, origin.y, outer);
  glint.addColorStop(0, rgba(palette[3], 0));
  glint.addColorStop(at(radius - half * 0.4), rgba(palette[0], glintAlpha * 0.6));
  glint.addColorStop(at(radius), rgba(palette[3], glintAlpha));
  glint.addColorStop(at(radius + half * 0.4), rgba(palette[1], glintAlpha * 0.6));
  glint.addColorStop(1, rgba(palette[1], 0));
  context.strokeStyle = glint;
  for (const edge of run.edges) {
    context.lineWidth = edge.line + 0.5;
    context.beginPath();
    if (edge.kind === "box") context.roundRect(edge.x + edge.line / 2, edge.y + edge.line / 2, edge.width - edge.line, edge.height - edge.line, Math.max(0, edge.radius - edge.line / 2));
    else { context.moveTo(edge.x1, edge.y1); context.lineTo(edge.x2, edge.y2); }
    context.stroke();
  }
}

function drawFrame(context: CanvasRenderingContext2D, run: Run, t: number) {
  const { origin, scheme } = run;
  const { width, height } = run.slice;
  const palette = HALO_PALETTE[scheme];
  context.clearRect(0, 0, width, height);
  if (run.reduced) {
    // Fades in and out in place: a soft glow around the button, no travelling ring, no glints, no shake.
    const alpha = haloRingAlpha(haloReducedStrength(t), scheme);
    const glow = context.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, HALO_BAND_PX * 2.5);
    glow.addColorStop(0, rgba(palette[3], alpha));
    glow.addColorStop(0.35, rgba(palette[0], alpha * 0.8));
    glow.addColorStop(0.7, rgba(palette[1], alpha * 0.4));
    glow.addColorStop(1, rgba(palette[1], 0));
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
    return;
  }
  // Trailing wave first (behind), then the brighter, thicker front wave with glints.
  const trailT = haloTrailTime(t);
  paintRing(context, run, trailT, haloTrailStrength(t), HALO_BAND_PX * 1.15, false);
  paintRing(context, run, t, haloStrength(t), HALO_BAND_PX, true);
}

/**
 * Transparent canvas overlay for the confirmed-compound halo: colour rings spreading from the Compound button that is
 * visible after the result dialog closes, plus faint glints on borders and dividers. The canvases cover only the
 * visible slice of the content area. It ignores the pointer, ends on a window resize, and is removed from the DOM at
 * rest. A very short translate (≤ 3px, ≤ 150ms) shakes the surface; reduced motion never shakes or moves the ring.
 */
export function CompoundSuccessHalo({ play, originRef }: { play: number; originRef: RefObject<HTMLElement | null> }) {
  const [run, setRun] = useState<Run | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    if (!play) return;
    const button = originRef.current;
    const surface = button?.closest<HTMLElement>(`[${HALO_SURFACE_ATTR}]`) ?? button?.closest<HTMLElement>("section")
      ?? document.querySelector<HTMLElement>(`[${HALO_SURFACE_ATTR}]`) ?? null;
    if (!surface) return;
    const box = surface.getBoundingClientRect();
    const slice = haloVisibleSlice(box, { width: window.innerWidth, height: window.innerHeight });
    if (!slice.width || !slice.height) return;
    const frame = { left: box.left + slice.x, top: box.top + slice.y, width: slice.width, height: slice.height };
    const target = button?.getBoundingClientRect() ?? null;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const surfaceStyle = getComputedStyle(surface);
    const radius = parseFloat(surfaceStyle.borderTopLeftRadius) > 0 ? surfaceStyle.borderTopLeftRadius : "var(--radius-surface, 28px)";
    setRun({ surface, scheme: resolveScheme(surface), reduced, radius, slice,
      origin: haloOriginPoint(target && target.width && target.height ? target : null, frame),
      edges: reduced ? [] : collectEdges(surface, frame) });
  }, [play, originRef]);
  useEffect(() => {
    if (!run) return;
    // A resize moves the layout under the overlay: end the run instead of drawing against stale geometry.
    const end = () => setRun(null);
    window.addEventListener("resize", end);
    return () => window.removeEventListener("resize", end);
  }, [run]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!run || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) { setRun(null); return; }
    const scale = haloCanvasScale(window.devicePixelRatio);
    canvas.width = Math.ceil(run.slice.width * scale); canvas.height = Math.ceil(run.slice.height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const box = run.surface.getBoundingClientRect();
    const frameBox = { left: box.left + run.slice.x, top: box.top + run.slice.y, width: run.slice.width, height: run.slice.height };
    const duration = run.reduced ? HALO_REDUCED_DURATION_MS : HALO_DURATION_MS;
    const previousTransform = run.surface.style.transform;
    const applyShake = (elapsed: number) => {
      const { x, y } = haloShake(elapsed, run.reduced);
      run.surface.style.transform = x || y ? `translate(${x}px, ${y}px)` : previousTransform;
    };
    let mask: HTMLCanvasElement | null = null;
    let frame = 0, cancelled = false;
    void buildHaloMask(run.surface, frameBox, scale).then((built) => {
      if (cancelled) { if (built) built.width = 0; return; }
      mask = built;
      const start = performance.now();
      const tick = (now: number) => {
        const elapsed = now - start;
        const t = haloProgress(elapsed, duration);
        applyShake(elapsed);
        drawFrame(context, run, t);
        protectTextAndIcons(context, mask, run);
        if (t >= 1) { applyShake(duration); setRun(null); return; }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      run.surface.style.transform = previousTransform;
      if (mask) { mask.width = 0; mask.height = 0; mask = null; }
      canvas.width = 0; canvas.height = 0;
    };
  }, [run]);
  if (!run) return null;
  return createPortal(<div aria-hidden="true" data-testid="compound-halo" data-halo-scheme={run.scheme} data-halo-reduced={run.reduced ? "true" : "false"}
    className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" style={{ borderRadius: run.radius }}>
    <canvas ref={canvasRef} data-testid="compound-halo-canvas" className="absolute block"
      style={{ left: run.slice.x, top: run.slice.y, width: run.slice.width, height: run.slice.height,
        mixBlendMode: run.scheme === "dark" ? "screen" : "normal" }} />
  </div>, run.surface);
}
