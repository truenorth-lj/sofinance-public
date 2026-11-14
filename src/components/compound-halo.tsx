"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  HALO_BAND_PX, HALO_DURATION_MS, HALO_PALETTE, HALO_REDUCED_DURATION_MS, haloCanvasScale, haloGlintAlpha, haloProgress, haloRadius,
  haloReach, haloReducedStrength, haloRingAlpha, haloStrength, haloVisibleSlice, parseOpaqueRgb, schemeForBackground, shouldPlayHalo,
  type HaloScheme, type HaloSlice, type Rgb,
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
 * Plays the halo once a compound transaction is CONFIRMED successful (the controller's feedback reaches "success" for
 * that signature). Clicking Compound never plays it. Returns a counter that changes on every play; a new play while
 * one runs restarts it.
 */
export function useCompoundSuccessHalo(feedback: Feedback): number {
  const lastPlayed = useRef<string | null>(null);
  const [play, setPlay] = useState(0);
  const phase = feedback?.phase ?? null;
  const signature = feedback?.signature ?? null;
  useEffect(() => {
    const current = phase && signature !== null ? { phase, signature } : null;
    if (!shouldPlayHalo(current, lastPlayed.current)) return;
    lastPlayed.current = signature;
    setPlay((count) => count + 1);
  }, [phase, signature]);
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
export async function buildHaloMask(surface: HTMLElement, frame: HaloFrame, scale: number): Promise<HTMLCanvasElement | null> {
  const mask = document.createElement("canvas");
  mask.width = Math.ceil(frame.width * scale); mask.height = Math.ceil(frame.height * scale);
  const context = mask.getContext("2d");
  if (!context) return null;
  context.scale(scale, scale); context.fillStyle = "#000"; context.textBaseline = "alphabetic";
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  const range = document.createRange();
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || parent.closest("canvas,script,style,svg")) continue;
    if (outside(parent.getBoundingClientRect(), frame)) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none") continue;
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

function drawFrame(context: CanvasRenderingContext2D, run: Run, t: number) {
  const { origin, scheme } = run;
  const { width, height } = run.slice;
  const palette = HALO_PALETTE[scheme];
  context.clearRect(0, 0, width, height);
  if (run.reduced) {
    // Fades in and out in place: a soft glow around the button, no travelling ring and no glints.
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
  const strength = haloStrength(t);
  // To just past the far corner of the visible slice (the canvas), not the whole content area.
  const reach = haloReach(origin, { width, height });
  const radius = haloRadius(t, reach);
  const half = HALO_BAND_PX / 2;
  const inner = Math.max(0, radius - half), outer = radius + half;
  if (outer <= 0 || strength <= 0) return;
  const at = (distance: number) => Math.max(0, Math.min(1, (distance - inner) / (outer - inner)));
  const ringAlpha = haloRingAlpha(strength, scheme);
  // The band's (1 − x²)² profile, coloured trailing green → mint → white front → blue fringe.
  const ring = context.createRadialGradient(origin.x, origin.y, inner, origin.x, origin.y, outer);
  ring.addColorStop(0, rgba(palette[2], 0));
  ring.addColorStop(at(radius - half * 0.55), rgba(palette[2], ringAlpha * 0.42));
  ring.addColorStop(at(radius - half * 0.15), rgba(palette[0], ringAlpha * 0.92));
  ring.addColorStop(at(radius + half * 0.1), rgba(palette[3], ringAlpha));
  ring.addColorStop(at(radius + half * 0.5), rgba(palette[1], ringAlpha * 0.42));
  ring.addColorStop(1, rgba(palette[1], 0));
  context.fillStyle = ring;
  context.fillRect(0, 0, width, height);
  // Faint glints where the front crosses a border or divider.
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

/**
 * Transparent canvas overlay for the confirmed-compound halo: colour rings spreading from the Compound button plus
 * faint glints on borders and dividers. The canvases cover only the visible slice of the content area. It never
 * snapshots or distorts the page, ignores the pointer, ends on a window resize, and is removed from the DOM at rest.
 */
export function CompoundSuccessHalo({ play, originRef }: { play: number; originRef: RefObject<HTMLElement | null> }) {
  const [run, setRun] = useState<Run | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    if (!play) return;
    const button = originRef.current;
    const surface = button?.closest<HTMLElement>(`[${HALO_SURFACE_ATTR}]`) ?? button?.closest<HTMLElement>("section") ?? null;
    if (!button || !surface) return;
    const box = surface.getBoundingClientRect();
    const slice = haloVisibleSlice(box, { width: window.innerWidth, height: window.innerHeight });
    if (!slice.width || !slice.height) return;
    const frame = { left: box.left + slice.x, top: box.top + slice.y, width: slice.width, height: slice.height };
    const target = button.getBoundingClientRect();
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const surfaceStyle = getComputedStyle(surface);
    const radius = parseFloat(surfaceStyle.borderTopLeftRadius) > 0 ? surfaceStyle.borderTopLeftRadius : "var(--radius-surface, 28px)";
    setRun({ surface, scheme: resolveScheme(surface), reduced, radius, slice,
      origin: { x: target.left - frame.left + target.width / 2, y: target.top - frame.top + target.height / 2 },
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
    let mask: HTMLCanvasElement | null = null;
    let frame = 0, cancelled = false;
    void buildHaloMask(run.surface, frameBox, scale).then((built) => {
      if (cancelled) { if (built) built.width = 0; return; }
      mask = built;
      const start = performance.now();
      const tick = (now: number) => {
        const t = haloProgress(now - start, duration);
        drawFrame(context, run, t);
        protectTextAndIcons(context, mask, run);
        if (t >= 1) { setRun(null); return; }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
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
