"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  BURST_DELAY_MS, CELEBRATION_MS, COIN_COUNT, FLIGHT_MS, REDUCED_MS, WOBBLE_KEYFRAMES, WOBBLE_MS, burstReach, coinFlights,
  flightKeyframes, nextCelebrationTrigger, pickCoinLogos, reducedSpots, seedFrom, seededRandom, visibleSlice,
  type CelebrationTriggerState, type CoinFlight,
} from "@/lib/compound-celebration/coins";

/** The page content area the coins are clipped to (below the top nav). Falls back to the Compound panel's own section. */
export const CELEBRATION_SURFACE_ATTR = "data-celebration-surface";
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
/** One play: `id` changes on every play (a new play while one runs restarts it); `logos` are already preloaded. */
export type CelebrationPlay = { id: number; seed: number; logos: string[] } | null;

const coinCount = () => (typeof window !== "undefined" && window.innerWidth < 640 ? COIN_COUNT.narrow : COIN_COUNT.wide);

function preload(urls: readonly string[]) {
  if (typeof Image === "undefined") return;
  for (const url of new Set(urls)) { const image = new Image(); image.decoding = "async"; image.src = url; }
}

/**
 * Plays the coin burst once a compound transaction is CONFIRMED successful, and only after any app result dialog for
 * that send has been closed (`held` is true while it is open). Clicking Compound never plays it. Once per signature.
 * The coins (mostly the position's own stock, from `symbols`) are chosen and preloaded as soon as the success arrives,
 * so they are ready when the dialog's OK is pressed.
 */
export function useCompoundCelebration(feedback: Feedback, held = false, symbols: readonly (string | null | undefined)[] = []): CelebrationPlay {
  const trigger = useRef<CelebrationTriggerState>({ lastPlayed: null, queued: null });
  const chosen = useRef<{ signature: string; seed: number; logos: string[] } | null>(null);
  const [play, setPlay] = useState<CelebrationPlay>(null);
  const phase = feedback?.phase ?? null;
  const signature = feedback?.signature ?? null;
  const symbolKey = symbols.join("|");
  useEffect(() => {
    const current = phase && signature ? { phase, signature } : null;
    const next = nextCelebrationTrigger(current, held, trigger.current);
    trigger.current = next.state;
    const queued = next.play ?? next.state.queued;
    if (queued && chosen.current?.signature !== queued) {
      const seed = seedFrom(queued);
      chosen.current = { signature: queued, seed, logos: pickCoinLogos(symbolKey.split("|"), coinCount(), seededRandom(seed)) };
      preload(chosen.current.logos);
    }
    if (next.play && chosen.current) {
      const { seed, logos } = chosen.current;
      setPlay((previous) => ({ id: (previous?.id ?? 0) + 1, seed, logos }));
    }
  }, [phase, signature, held, symbolKey]);
  useEffect(() => {
    if (!celebrationPreviewEnabled()) return;
    const preview = () => {
      const seed = Math.floor(Math.random() * 2 ** 31);
      setPlay((previous) => ({ id: (previous?.id ?? 0) + 1, seed, logos: pickCoinLogos(symbolKey.split("|"), coinCount(), seededRandom(seed)) }));
    };
    window.addEventListener(CELEBRATION_PREVIEW_EVENT, preview);
    return () => window.removeEventListener(CELEBRATION_PREVIEW_EVENT, preview);
  }, [symbolKey]);
  return play;
}

type Run = { id: number; surface: HTMLElement; button: HTMLElement | null; radius: string; reduced: boolean;
  origin: { x: number; y: number }; flights: CoinFlight[]; logos: string[] };

/** One coin: an outer layer that travels and fades, an inner 3D layer that tilts (rim, edge, face, shine). */
function Coin({ flight, logo, origin }: { flight: CoinFlight; logo: string; origin: { x: number; y: number } }) {
  const { size } = flight;
  const face = Math.round(size * 0.1);
  const disc = { position: "absolute", inset: 0, borderRadius: "50%" } as const;
  return <div data-coin="" style={{ position: "absolute", left: origin.x - size / 2, top: origin.y - size / 2, width: size, height: size,
    opacity: 0, zIndex: Math.round(flight.depth * 10), perspective: 420, filter: flight.blur ? `blur(${flight.blur}px)` : undefined, willChange: "transform, opacity" }}>
    <div data-coin-turn="" style={{ ...disc, transformStyle: "preserve-3d", willChange: "transform" }}>
      {/* The coin's edge: two darker discs a little behind the face, seen when it tilts. */}
      <span style={{ ...disc, transform: "translateZ(-4px)", background: "linear-gradient(140deg, #7d838c, #2f3238)" }} />
      <span style={{ ...disc, transform: "translateZ(-2px)", background: "linear-gradient(140deg, #aab1ba, #474b52)" }} />
      {/* Brushed-metal rim. */}
      <span style={{ ...disc, background: "conic-gradient(from 210deg, #f5f7f9, #9aa1ab 25%, #eef1f4 50%, #8b929c 75%, #f5f7f9)",
        boxShadow: "0 8px 18px rgba(0, 0, 0, 0.45)" }} />
      {/* eslint-disable-next-line @next/next/no-img-element -- a preloaded remote logo inside a decorative, aria-hidden coin */}
      <img src={logo} alt="" draggable={false} style={{ ...disc, inset: face, width: size - face * 2, height: size - face * 2, objectFit: "cover" }} />
      <span style={{ ...disc, inset: face,
        background: "radial-gradient(circle at 30% 24%, rgba(255,255,255,0.55), rgba(255,255,255,0) 46%), radial-gradient(circle at 72% 82%, rgba(0,0,0,0.28), rgba(0,0,0,0) 58%)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.28), inset 0 -3px 6px rgba(0,0,0,0.35)" }} />
    </div>
  </div>;
}

/**
 * Tokenized-stock coins bursting out of the Compound button like a gift box opening: the button wobbles (≤ 300 ms),
 * then the coins fly out in an upward fan at different depths, turn a little and fade out (≈ 1.6 s in all). The overlay
 * is clipped to the content area below the nav, ignores the pointer, ends on a window resize, and is removed from the
 * DOM at rest. Reduced motion: no wobble and no flight, three coins fade in and out beside the button.
 */
export function CompoundTokenBurst({ play, originRef }: { play: CelebrationPlay; originRef: RefObject<HTMLElement | null> }) {
  const [run, setRun] = useState<Run | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!play) return;
    const button = originRef.current;
    const surface = button?.closest<HTMLElement>(`[${CELEBRATION_SURFACE_ATTR}]`) ?? button?.closest<HTMLElement>("section")
      ?? document.querySelector<HTMLElement>(`[${CELEBRATION_SURFACE_ATTR}]`) ?? null;
    if (!surface) return;
    const box = surface.getBoundingClientRect();
    const slice = visibleSlice(box, { width: window.innerWidth, height: window.innerHeight });
    if (!slice.width || !slice.height) return;
    const target = button?.getBoundingClientRect() ?? null;
    const onScreen = Boolean(target && target.width && target.height && target.bottom > box.top + slice.y && target.top < box.top + slice.y + slice.height);
    // From the button; if it is missing or scrolled away, from low in the middle of what is visible.
    const origin = onScreen && target
      ? { x: target.left + target.width / 2 - box.left, y: target.top + target.height / 2 - box.top }
      : { x: slice.x + slice.width / 2, y: slice.y + slice.height * 0.75 };
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const style = getComputedStyle(surface);
    setRun({ id: play.id, surface, button: onScreen ? button : null, reduced, origin,
      radius: parseFloat(style.borderTopLeftRadius) > 0 ? style.borderTopLeftRadius : "var(--radius-surface, 28px)",
      flights: reduced ? reducedSpots() : coinFlights(play.logos.length, burstReach(slice), seededRandom(play.seed)),
      logos: reduced ? play.logos.slice(0, reducedSpots().length) : play.logos });
  }, [play, originRef]);
  useEffect(() => {
    if (!run) return;
    const animations: Animation[] = [];
    const animate = (element: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      if (!element || typeof element.animate !== "function") return;
      const animation = element.animate(keyframes, options);
      // Cancelling (end of play, resize, unmount) rejects `finished`; that is expected, not an error.
      animation.finished?.catch(() => {});
      animations.push(animation);
    };
    if (!run.reduced) animate(run.button, [...WOBBLE_KEYFRAMES], { duration: WOBBLE_MS, easing: "ease-out" });
    const coins = layerRef.current?.querySelectorAll<HTMLElement>("[data-coin]") ?? [];
    coins.forEach((coin, index) => {
      const flight = run.flights[index];
      if (!flight) return;
      if (run.reduced) {
        animate(coin, [{ opacity: 0 }, { opacity: 0.9, offset: 0.4 }, { opacity: 0 }], { duration: REDUCED_MS, fill: "both" });
        coin.style.transform = `translate3d(${flight.dx}px, ${flight.dy}px, 0)`;
        return;
      }
      const { move, turn } = flightKeyframes(flight);
      const timing = { duration: FLIGHT_MS, delay: BURST_DELAY_MS + flight.delay, fill: "both" as const };
      animate(coin, move, timing);
      animate(coin.firstElementChild, turn, timing);
    });
    const end = window.setTimeout(() => setRun(null), run.reduced ? REDUCED_MS : CELEBRATION_MS);
    // A resize moves the layout under the overlay: end the run instead of flying from a stale origin.
    const stop = () => setRun(null);
    window.addEventListener("resize", stop);
    return () => {
      window.clearTimeout(end);
      window.removeEventListener("resize", stop);
      for (const animation of animations) animation.cancel();
    };
  }, [run]);
  if (!run) return null;
  return createPortal(<div ref={layerRef} key={run.id} aria-hidden="true" data-testid="compound-token-burst" data-celebration-reduced={run.reduced ? "true" : "false"}
    className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" style={{ borderRadius: run.radius }}>
    {run.flights.map((flight, index) => <Coin key={index} flight={flight} logo={run.logos[index % run.logos.length]!} origin={run.origin} />)}
  </div>, run.surface);
}
