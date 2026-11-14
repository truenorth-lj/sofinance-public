"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  HALO_BAND_PX, HALO_DURATION_MS, HALO_PALETTE, HALO_REDUCED_DURATION_MS, haloGlintAlpha, haloProgress, haloRadius, haloReach,
  haloReducedStrength, haloRingAlpha, haloStrength, parseOpaqueRgb, schemeForBackground, shouldPlayHalo,
  type HaloScheme, type Rgb,
} from "@/lib/compound-halo/math";

/** The page content area the halo is clipped to (below the top nav). Falls back to the Compound panel's own section. */
export const HALO_SURFACE_ATTR = "data-halo-surface";
/** Visual-only preview hook for screenshots and tests: `window.dispatchEvent(new Event(HALO_PREVIEW_EVENT))`. */
export const HALO_PREVIEW_EVENT = "sofinance:compound-halo-preview";

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

/** Borders and dividers inside the surface, in surface coordinates. Text and icons are never collected. */
function collectEdges(surface: HTMLElement, origin: DOMRect): Edge[] {
  const edges: Edge[] = [];
  for (const element of surface.querySelectorAll<HTMLElement>("*")) {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const sides = (["Top", "Right", "Bottom", "Left"] as const).filter((side) => visibleBorder(style, side));
    if (!sides.length) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
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

/**
 * A glyph mask, not a page image: paint only text glyphs and icon boxes into an offscreen transparency mask, then cut
 * those pixels out of the light layer. Never copies page surfaces, colours or content into the visible canvas.
 */
function textMask(surface: HTMLElement, box: DOMRect, scale: number): HTMLCanvasElement | null {
  const mask = document.createElement("canvas");
  mask.width = Math.ceil(box.width * scale); mask.height = Math.ceil(box.height * scale);
  const context = mask.getContext("2d");
  if (!context) return null;
  context.scale(scale, scale); context.fillStyle = "#000"; context.textBaseline = "alphabetic";
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  const range = document.createRange();
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || parent.closest("canvas,script,style,svg")) continue;
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
      const baseline = rect.top - box.top + (rect.height + ascent - descent) / 2;
      context.fillText(char, rect.left - box.left, baseline);
    }
  }
  range.detach();
  for (const icon of surface.querySelectorAll("svg,img,video,input,textarea")) {
    const rect = icon.getBoundingClientRect();
    if (rect.width && rect.height) context.fillRect(rect.left - box.left, rect.top - box.top, rect.width, rect.height);
  }
  return mask;
}

type Run = { surface: HTMLElement; scheme: HaloScheme; reduced: boolean; radius: string; width: number; height: number;
  origin: { x: number; y: number }; edges: Edge[] };

function protectTextAndIcons(context: CanvasRenderingContext2D, mask: HTMLCanvasElement | null, run: Run) {
  if (!mask) return;
  context.save(); context.globalCompositeOperation = "destination-out";
  context.drawImage(mask, 0, 0, run.width, run.height);
  context.restore();
}

function drawFrame(context: CanvasRenderingContext2D, run: Run, t: number) {
  const { origin, scheme, width, height } = run;
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
 * faint glints on borders and dividers. It never snapshots or distorts the page, ignores the pointer, and is removed
 * from the DOM when it is not playing.
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
    const target = button.getBoundingClientRect();
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const surfaceStyle = getComputedStyle(surface);
    const radius = parseFloat(surfaceStyle.borderTopLeftRadius) > 0 ? surfaceStyle.borderTopLeftRadius : "var(--radius-surface, 28px)";
    setRun({ surface, scheme: resolveScheme(surface), reduced, radius, width: box.width, height: box.height,
      origin: { x: target.left - box.left + target.width / 2, y: target.top - box.top + target.height / 2 },
      edges: reduced ? [] : collectEdges(surface, box) });
  }, [play, originRef]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!run || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) { setRun(null); return; }
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.ceil(run.width * scale); canvas.height = Math.ceil(run.height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const mask = textMask(run.surface, run.surface.getBoundingClientRect(), scale);
    const duration = run.reduced ? HALO_REDUCED_DURATION_MS : HALO_DURATION_MS;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = haloProgress(now - start, duration);
      drawFrame(context, run, t);
      protectTextAndIcons(context, mask, run);
      if (t >= 1) { setRun(null); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run]);
  if (!run) return null;
  return createPortal(<div aria-hidden="true" data-testid="compound-halo" data-halo-scheme={run.scheme} data-halo-reduced={run.reduced ? "true" : "false"}
    className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" style={{ borderRadius: run.radius }}>
    <canvas ref={canvasRef} className="block h-full w-full"
      style={{ mixBlendMode: run.scheme === "dark" ? "screen" : "normal", borderRadius: run.radius }} />
  </div>, run.surface);
}
