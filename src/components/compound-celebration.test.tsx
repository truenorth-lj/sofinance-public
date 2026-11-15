// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CELEBRATION_MS, COIN_GRID, FALL_MS, REDUCED_COINS, REDUCED_MS, STAGGER_MS, STOCK_COIN_LOGOS } from "@/lib/compound-celebration/coins";
import { CELEBRATION_PREVIEW_EVENT, CompoundTokenBurst, celebrationPreviewEnabled, useCompoundCelebration } from "./compound-celebration";

type Feedback = { phase: "submitting" | "confirming" | "success" | "failed"; signature: string } | null;
let setFeedback: (next: Feedback) => void;
let container: HTMLDivElement, root: Root;
let animations: { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[];
let preloaded: string[];
let popovers: number;
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

/**
 * The Compound popup's wiring in miniature: the row button only starts the send; confirmation sets "success"; the
 * result's Done plays the coins from itself and closes (clears the result); Close (✕) just clears it.
 */
function Harness({ symbols = ["NVDAx", "USDC"] }: { symbols?: string[] }) {
  const [feedback, set] = useState<Feedback>(null);
  const button = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const celebration = useCompoundCelebration(feedback, symbols);
  useLayoutEffect(() => { setFeedback = set; }, []);
  return <section>
    <button ref={button} type="button" onClick={() => set({ phase: "submitting", signature: "" })}>Compound</button>
    {feedback ? <>
      <button ref={done} type="button" data-done="" onClick={() => { celebration.celebrateFrom(done.current?.getBoundingClientRect()); set(null); }}>Done</button>
      <button type="button" data-close="" onClick={() => set(null)}>✕</button>
    </> : null}
    <CompoundTokenBurst play={celebration.play} originRef={button} />
  </section>;
}
const burst = () => document.querySelector<HTMLElement>('[data-testid="compound-token-burst"]');
const pressDone = async () => { await act(async () => container.querySelector<HTMLButtonElement>("[data-done]")?.click()); };
const pressClose = async () => { await act(async () => container.querySelector<HTMLButtonElement>("[data-close]")?.click()); };
/** The coins that pop out of the origin (not the big knock coin, which drops from above the screen). */
const coins = () => [...document.querySelectorAll<HTMLElement>("[data-coin]:not([data-coin-knock])")];
const allCoinLogos = () => [...document.querySelectorAll<HTMLElement>("[data-coin]")].map((coin) => coin.getAttribute("data-logo"));
const coinLogos = () => coins().map((coin) => coin.getAttribute("data-logo"));
/** Where a coin starts (its centre), in viewport px. */
const start = (coin: HTMLElement) => ({ x: parseFloat(coin.style.left) + parseFloat(coin.style.width) / 2, y: parseFloat(coin.style.top) + parseFloat(coin.style.height) / 2 });
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
/** A confirmed compound whose result's Done is then clicked. */
const confirmAndDone = async (signature = "sig1") => {
  await act(async () => setFeedback({ phase: "success", signature }));
  await pressDone();
};

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  animations = []; preloaded = []; popovers = 0;
  vi.stubGlobal("innerWidth", 1280); vi.stubGlobal("innerHeight", 900);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-done")) return rect(500, 600, 160, 48);
    if (this.tagName === "BUTTON") return rect(100, 300, 200, 40);
    return rect(0, 0, 0, 0);
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, writable: true, value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { target: this, keyframes, options, cancel: vi.fn() };
    animations.push(animation);
    return animation as unknown as Animation;
  } });
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, writable: true, value() { popovers++; } });
  vi.stubGlobal("Image", class { decoding = ""; set src(value: string) { preloaded.push(value); } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete (Element.prototype as { animate?: unknown }).animate;
  delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("compound success coins", () => {
  it("plays only when the confirmed result's Done is clicked: not on click, while confirming, or on the success itself", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => setFeedback({ phase: "confirming", signature: "sig1" }));
    expect(burst()).toBeNull();
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(1000);
    expect(burst()).toBeNull();
    // Armed: its coins are chosen and preloaded while the result shows.
    expect(preloaded.length).toBeGreaterThan(0);
    await pressDone();
    expect(burst()).not.toBeNull();
    expect(burst()!.getAttribute("aria-hidden")).toBe("true");
    expect(burst()!.style.pointerEvents).toBe("none");
    expect(burst()!.style.position).toBe("fixed");
    // A full-screen layer on the body, shown as a popover so it draws above an open modal dialog.
    expect(burst()!.parentElement).toBe(document.body);
    expect(burst()!.getAttribute("popover")).toBe("manual");
    expect(popovers).toBe(1);
    await advance(CELEBRATION_MS + 10);
    expect(burst()).toBeNull();
  });

  it("pops the coins out of the Done button with the logos it preloaded", async () => {
    await act(async () => root.render(createElement(Harness)));
    await confirmAndDone();
    expect(coins().length).toBeGreaterThan(0);
    for (const coin of coins()) { expect(start(coin).x).toBeCloseTo(580, 3); expect(start(coin).y).toBeCloseTo(624, 3); }
    expect(new Set(coinLogos())).toEqual(new Set(preloaded));
  });

  it("closing the result another way (✕, Escape, backdrop) plays nothing", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await pressClose();
    await advance(CELEBRATION_MS + 10);
    expect(burst()).toBeNull();
  });

  it("a failed or unconfirmed compound never plays, even when its button is clicked", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "failed", signature: "sig2" }));
    await pressDone();
    await act(async () => setFeedback({ phase: "confirming", signature: "sig3" }));
    await pressDone();
    expect(burst()).toBeNull();
  });

  it("plays once per signature; a new confirmation plays again from its own Done", async () => {
    await act(async () => root.render(createElement(Harness)));
    await confirmAndDone("sig1");
    await advance(CELEBRATION_MS + 10);
    await confirmAndDone("sig1");
    expect(burst()).toBeNull();
    await confirmAndDone("sig2");
    expect(burst()).not.toBeNull();
  });

  it("drops 14 pixel coins plus the big knock coin of the position's own stock, each with a fall and a spin animation", async () => {
    await act(async () => root.render(createElement(Harness)));
    await confirmAndDone();
    expect(coinLogos()).toHaveLength(14);
    expect(coinLogos().filter((src) => src === STOCK_COIN_LOGOS.NVDA)).toHaveLength(7);
    // The knock coin is the position's own stock.
    expect(allCoinLogos()).toHaveLength(15);
    expect(document.querySelector("[data-coin-knock]")!.getAttribute("data-logo")).toBe(STOCK_COIN_LOGOS.NVDA);
    const knock = document.querySelector("[data-coin-knock]");
    const falls = animations.filter((animation) => (animation.target as HTMLElement).hasAttribute?.("data-coin"));
    const spins = animations.filter((animation) => (animation.target as HTMLElement).hasAttribute?.("data-coin-turn"));
    expect(falls).toHaveLength(15);
    expect(spins).toHaveLength(15);
    for (const animation of falls.filter((a) => a.target !== knock)) {
      expect(animation.options.duration).toBe(FALL_MS);
      expect(Number(animation.options.delay)).toBeLessThanOrEqual(STAGGER_MS);
      expect(animation.keyframes[0]!.offset).toBe(0);
      expect(animation.keyframes.at(-1)!.offset).toBe(1);
    }
    // A 2D spin: it narrows and widens, never rotated off the pixel grid.
    for (const animation of spins) for (const frame of animation.keyframes) expect(String(frame.transform)).toMatch(/^scaleX\((0\.\d{3}|1\.000)\)$/);
    expect(falls.find((a) => a.target === knock)!.options.duration).toBe(CELEBRATION_MS);
    expect(falls.every((animation) => animation.keyframes.at(-1)!.opacity === 0)).toBe(true);
  });

  it("draws each coin as a 16 × 16 pixel sprite scaled up by whole pixels, with crisp edges", async () => {
    await act(async () => root.render(createElement(Harness)));
    await confirmAndDone();
    const all = [...document.querySelectorAll<HTMLElement>("[data-coin]")];
    expect(all).toHaveLength(15);
    for (const coin of all) {
      const canvas = coin.querySelector("canvas")!;
      expect([canvas.width, canvas.height]).toEqual([COIN_GRID, COIN_GRID]);
      expect(canvas.style.imageRendering).toBe("pixelated");
      expect(parseFloat(coin.style.width) % COIN_GRID).toBe(0);
      expect(coin.style.filter).toBe("");
    }
  });

  it("adds the little pixel character, bigger now: it runs, tips over and switches poses with the play", async () => {
    await act(async () => root.render(createElement(Harness)));
    await confirmAndDone();
    const catcher = document.querySelector<HTMLElement>("[data-catcher]")!;
    expect(catcher).not.toBeNull();
    // A 24 × 28 sprite at 4 CSS px a pixel on a wide screen: 96 × 112.
    expect([parseFloat(catcher.style.width), parseFloat(catcher.style.height)]).toEqual([96, 112]);
    expect(catcher.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 24 28");
    expect(catcher.querySelectorAll("[data-catcher-pose]")).toHaveLength(3);
    expect(catcher.querySelectorAll("rect").length).toBeGreaterThan(20);
    const on = (target: Element | null) => animations.filter((animation) => animation.target === target);
    expect(on(catcher)).toHaveLength(1);
    expect(on(catcher.querySelector("[data-catcher-tilt]"))).toHaveLength(1);
    for (const pose of ["stand", "runA", "runB"]) expect(on(catcher.querySelector(`[data-catcher-pose="${pose}"]`))).toHaveLength(1);
    expect(on(catcher)[0]!.options.duration).toBe(CELEBRATION_MS);
    expect(String(on(catcher.querySelector("[data-catcher-tilt]"))[0]!.keyframes.at(-1)!.transform)).toContain("rotate(-90deg)");
    await advance(CELEBRATION_MS + 10);
    expect(document.querySelector("[data-catcher]")).toBeNull();
  });

  it("cancels its animations when it ends early on a resize", async () => {
    await act(async () => root.render(createElement(Harness)));
    await confirmAndDone();
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(burst()).toBeNull();
    expect(animations.length).toBeGreaterThan(0);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it("reduced motion: no pop and no fall, three coins fade beside Done", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    await act(async () => root.render(createElement(Harness)));
    await confirmAndDone();
    expect(burst()?.getAttribute("data-celebration-reduced")).toBe("true");
    expect(coinLogos()).toHaveLength(REDUCED_COINS);
    expect(document.querySelector("[data-catcher]")).toBeNull();
    expect(animations.every((animation) => animation.keyframes.every((frame) => !("transform" in frame)))).toBe(true);
    await advance(REDUCED_MS + 10);
    expect(burst()).toBeNull();
  });

  it("the visual preview event plays it without any transaction, and is off in production builds", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { window.dispatchEvent(new Event(CELEBRATION_PREVIEW_EVENT)); });
    expect(burst()).not.toBeNull();
    expect(celebrationPreviewEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(celebrationPreviewEnabled({ NODE_ENV: "production", NEXT_PUBLIC_CELEBRATION_PREVIEW: "1" })).toBe(true);
    expect(celebrationPreviewEnabled({ NODE_ENV: "development" })).toBe(true);
  });
});
