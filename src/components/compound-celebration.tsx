"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  CATCHER_SPRITES, CELEBRATION_MS, COIN_COUNT, FALL_MS, REDUCED_MS, beadFlights, beadKeyframes, catcherKeyframes, celebrationToPlay,
  pickCoinLogos, planCatcher, reducedSpots, seedFrom, seededRandom, spriteRuns,
  type CatcherPlan, type CatcherPose, type Point,
} from "@/lib/compound-celebration/coins";

/** Visual-only preview hook for screenshots and tests: `window.dispatchEvent(new Event(CELEBRATION_PREVIEW_EVENT))`. */
export const CELEBRATION_PREVIEW_EVENT = "sofinance:compound-celebration-preview";

/**
 * The preview hook is off in production builds. It is on in `next dev` and tests (NODE_ENV is not "production"), and in
 * a production build only when built with NEXT_PUBLIC_CELEBRATION_PREVIEW=1 (local screenshot builds; never on Vercel).
 */
export function celebrationPreviewEnabled(env: { NODE_ENV?: string; NEXT_PUBLIC_CELEBRATION_PREVIEW?: string } = {
  NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_CELEBRATION_PREVIEW: process.env.NEXT_PUBLIC_CELEBRATION_PREVIEW,
}): boolean {
  return env.NODE_ENV !== "production" || env.NEXT_PUBLIC_CELEBRATION_PREVIEW === "1";
}

type Feedback = { phase: string; signature: string } | null;
/**
 * One play: `id` changes on every play (a new play while one runs restarts it); `logos` are already preloaded.
 * The coins pop out of the burst's `originRef` (the popup's Done, or the row's Compound button).
 */
export type CelebrationPlay = { id: number; seed: number; logos: string[] } | null;

const coinCount = () => (typeof window !== "undefined" && window.innerWidth < 640 ? COIN_COUNT.narrow : COIN_COUNT.wide);
const centre = (rect: { left: number; top: number; width: number; height: number }): Point =>
  ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

function preload(urls: readonly string[]) {
  if (typeof Image === "undefined") return;
  for (const url of new Set(urls)) { const image = new Image(); image.decoding = "async"; image.src = url; }
}

/**
 * Coins for a CONFIRMED compound, played on the confirmed landing, once per signature. Clicking Compound never plays
 * them. The position's `symbols` choose the logos (preloaded with the play).
 */
export function useCompoundCelebration(feedback: Feedback, symbols: readonly (string | null | undefined)[] = []): { play: CelebrationPlay } {
  const lastPlayed = useRef<string | null>(null);
  const [play, setPlay] = useState<CelebrationPlay>(null);
  const phase = feedback?.phase ?? null;
  const signature = feedback?.signature ?? null;
  const symbolKey = symbols.join("|");
  useEffect(() => {
    const next = celebrationToPlay(phase && signature ? { phase, signature } : null, lastPlayed.current);
    if (!next) return;
    lastPlayed.current = next;
    const seed = seedFrom(next);
    const logos = pickCoinLogos(symbolKey.split("|"), coinCount(), seededRandom(seed));
    preload(logos);
    setPlay((previous) => ({ id: (previous?.id ?? 0) + 1, seed, logos }));
  }, [phase, signature, symbolKey]);
  useEffect(() => {
    if (!celebrationPreviewEnabled()) return;
    const preview = () => {
      const seed = Math.floor(Math.random() * 2 ** 31);
      setPlay((previous) => ({ id: (previous?.id ?? 0) + 1, seed, logos: pickCoinLogos(symbolKey.split("|"), coinCount(), seededRandom(seed)) }));
    };
    window.addEventListener(CELEBRATION_PREVIEW_EVENT, preview);
    return () => window.removeEventListener(CELEBRATION_PREVIEW_EVENT, preview);
  }, [symbolKey]);
  return { play };
}

type Coin = { size: number; blur: number; depth: number; delay: number; logo: string;
  move: Keyframe[] | null; turn: Keyframe[] | null; at: Point; duration: number; knock?: boolean };
type Run = { id: number; reduced: boolean; origin: Point; coins: Coin[]; catcher: CatcherPlan | null };

/** The logo that appears most often in a play: the position's own stock when it has one. */
function mostCommon(logos: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const logo of logos) counts.set(logo, (counts.get(logo) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? logos[0]!;
}

const POSES: CatcherPose[] = ["stand", "runA", "runB"];

/** The little pixel character: an outer layer that runs and fades, an inner layer that tips over, one sprite per pose. */
function CatcherView({ plan }: { plan: CatcherPlan }) {
  return <div data-catcher="" style={{ position: "absolute", left: plan.startX - plan.width / 2, top: plan.feetY - plan.height,
    width: plan.width, height: plan.height, opacity: 0, zIndex: 6, willChange: "transform, opacity" }}>
    <div data-catcher-tilt="" style={{ position: "absolute", inset: 0, transformOrigin: "50% 100%", willChange: "transform" }}>
      {POSES.map((pose) => <svg key={pose} data-catcher-pose={pose} viewBox="0 0 12 14" width={plan.width} height={plan.height} shapeRendering="crispEdges"
        style={{ position: "absolute", inset: 0, opacity: pose === "stand" ? 1 : 0 }}>
        {spriteRuns(CATCHER_SPRITES[pose]).map((run) => <rect key={`${run.x}-${run.y}`} x={run.x} y={run.y} width={run.width} height={1} fill={run.color} />)}
      </svg>)}
    </div>
  </div>;
}

/** One coin: an outer layer that travels and fades, an inner 3D layer that wobbles and rolls (rim, edge, face, shine). */
function CoinView({ coin }: { coin: Coin }) {
  const { size } = coin;
  const face = Math.round(size * 0.1);
  const disc = { position: "absolute", inset: 0, borderRadius: "50%" } as const;
  return <div data-coin="" data-coin-knock={coin.knock ? "" : undefined} style={{ position: "absolute", left: coin.at.x - size / 2, top: coin.at.y - size / 2, width: size, height: size,
    opacity: 0, zIndex: Math.round(coin.depth * 10), perspective: 420, filter: coin.blur ? `blur(${coin.blur}px)` : undefined, willChange: "transform, opacity" }}>
    <div data-coin-turn="" style={{ ...disc, transformStyle: "preserve-3d", willChange: "transform" }}>
      {/* The coin's edge: two darker discs a little behind the face, seen when it tilts. */}
      <span style={{ ...disc, transform: "translateZ(-4px)", background: "linear-gradient(140deg, #7d838c, #2f3238)" }} />
      <span style={{ ...disc, transform: "translateZ(-2px)", background: "linear-gradient(140deg, #aab1ba, #474b52)" }} />
      {/* Brushed-metal rim. */}
      <span style={{ ...disc, background: "conic-gradient(from 210deg, #f5f7f9, #9aa1ab 25%, #eef1f4 50%, #8b929c 75%, #f5f7f9)",
        boxShadow: "0 8px 18px rgba(0, 0, 0, 0.45)" }} />
      {/* eslint-disable-next-line @next/next/no-img-element -- a preloaded remote logo inside a decorative, aria-hidden coin */}
      <img src={coin.logo} alt="" draggable={false} style={{ ...disc, inset: face, width: size - face * 2, height: size - face * 2, objectFit: "cover" }} />
      <span style={{ ...disc, inset: face,
        background: "radial-gradient(circle at 30% 24%, rgba(255,255,255,0.55), rgba(255,255,255,0) 46%), radial-gradient(circle at 72% 82%, rgba(0,0,0,0.28), rgba(0,0,0,0) 58%)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.28), inset 0 -3px 6px rgba(0,0,0,0.35)" }} />
    </div>
  </div>;
}

/**
 * Tokenized-stock coins popping out of `originRef` (the popup's Done or the row's Compound button; low in the middle of the screen when it is off screen), and falling like beads to the bottom of the screen: they bounce lower each time, roll to a stop and fade.
 * A little pixel character runs along the bottom collecting a few of them, then a big coin of the position's own stock
 * drops on its head and it falls over (≈ 2.9 s in all). A full-screen layer that ignores the pointer; it is shown as a manual popover so it draws above the open
 * result dialog (top layer), and is a plain fixed layer where popovers are not supported. Ends on a window resize and
 * is removed from the DOM at rest. Reduced motion: no pop and no fall, three coins fade beside the origin.
 */
export function CompoundTokenBurst({ play, originRef }: { play: CelebrationPlay; originRef: RefObject<HTMLElement | null> }) {
  const [run, setRun] = useState<Run | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!play) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const button = originRef.current?.getBoundingClientRect() ?? null;
    const buttonOnScreen = button && button.width && button.height && button.bottom > 0 && button.top < viewport.height;
    const origin = buttonOnScreen ? centre(button) : { x: viewport.width / 2, y: viewport.height * 0.6 };
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setRun({ id: play.id, reduced, origin, catcher: null, coins: reducedSpots(origin).map((spot, index) => ({ size: spot.size, blur: 0, depth: 0.5,
        delay: 0, logo: play.logos[index % play.logos.length]!, move: null, turn: null, at: { x: spot.x, y: spot.y }, duration: REDUCED_MS })) });
      return;
    }
    const rand = seededRandom(play.seed);
    const flights = beadFlights(play.logos.length, origin, viewport, rand);
    // Plans the character against the coins (marks the ones it collects) before their keyframes are made.
    const catcher = planCatcher(flights, origin, viewport, rand);
    const coins: Coin[] = flights.map((flight, index) => {
      const { move, turn } = beadKeyframes(flight, origin);
      return { size: flight.size, blur: flight.blur, depth: flight.depth, delay: flight.delay, logo: play.logos[index]!, move, turn, at: origin, duration: FALL_MS };
    });
    const knockStart = { x: catcher.knock.frames[0]!.x, y: catcher.knock.frames[0]!.y };
    const knock = beadKeyframes({ frames: catcher.knock.frames }, knockStart, CELEBRATION_MS / 1000);
    coins.push({ size: catcher.knock.size, blur: 0, depth: 1, delay: 0, logo: mostCommon(play.logos), move: knock.move, turn: knock.turn,
      at: knockStart, duration: CELEBRATION_MS, knock: true });
    setRun({ id: play.id, reduced, origin, coins, catcher });
  }, [play, originRef]);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!run || !layer) return;
    // Above the open result dialog: a popover shown after it is drawn on top of it.
    // Each play mounts a fresh layer (keyed by play), so it is never already open.
    try { if (typeof layer.showPopover === "function") layer.showPopover(); } catch { /* plain fixed layer */ }
    const animations: Animation[] = [];
    const animate = (element: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      if (!element || typeof element.animate !== "function") return;
      const animation = element.animate(keyframes, options);
      // Cancelling (end of play, resize, unmount) rejects `finished`; that is expected, not an error.
      animation.finished?.catch(() => {});
      animations.push(animation);
    };
    layer.querySelectorAll<HTMLElement>("[data-coin]").forEach((element, index) => {
      const coin = run.coins[index];
      if (!coin) return;
      if (run.reduced || !coin.move || !coin.turn) {
        animate(element, [{ opacity: 0 }, { opacity: 0.9, offset: 0.4 }, { opacity: 0 }], { duration: REDUCED_MS, fill: "both" });
        return;
      }
      const timing = { duration: coin.duration, delay: coin.delay, fill: "both" as const };
      animate(element, coin.move, timing);
      animate(element.firstElementChild, coin.turn, timing);
    });
    const catcher = layer.querySelector<HTMLElement>("[data-catcher]");
    if (run.catcher && catcher) {
      const { move, tilt, poses } = catcherKeyframes(run.catcher);
      const timing = { duration: CELEBRATION_MS, fill: "both" as const };
      animate(catcher, move, timing);
      animate(catcher.querySelector("[data-catcher-tilt]"), tilt, timing);
      for (const pose of POSES) animate(catcher.querySelector(`[data-catcher-pose="${pose}"]`), poses[pose], timing);
    }
    const end = window.setTimeout(() => setRun(null), run.reduced ? REDUCED_MS : CELEBRATION_MS);
    // A resize moves the floor and the walls: end the run instead of bouncing off stale edges.
    const stop = () => setRun(null);
    window.addEventListener("resize", stop);
    return () => {
      window.clearTimeout(end);
      window.removeEventListener("resize", stop);
      for (const animation of animations) animation.cancel();
    };
  }, [run]);
  if (!run || typeof document === "undefined") return null;
  return createPortal(<div ref={layerRef} key={run.id} popover="manual" aria-hidden="true" data-testid="compound-token-burst"
    data-celebration-reduced={run.reduced ? "true" : "false"}
    style={{ position: "fixed", inset: 0, width: "100vw", height: "100dvh", maxWidth: "none", maxHeight: "none", margin: 0, padding: 0,
      border: 0, background: "transparent", overflow: "hidden", pointerEvents: "none", zIndex: 60 }}>
    {run.coins.map((coin, index) => <CoinView key={index} coin={coin} />)}
    {run.catcher && <CatcherView plan={run.catcher} />}
  </div>, document.body);
}
