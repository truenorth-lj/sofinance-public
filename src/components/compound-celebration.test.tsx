// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CELEBRATION_MS, REDUCED_COINS, REDUCED_MS, STOCK_COIN_LOGOS, WOBBLE_KEYFRAMES } from "@/lib/compound-celebration/coins";
import { CELEBRATION_PREVIEW_EVENT, CompoundTokenBurst, celebrationPreviewEnabled, useCompoundCelebration } from "./compound-celebration";

type Feedback = { phase: "submitting" | "confirming" | "success" | "failed"; signature: string } | null;
let setFeedback: (next: Feedback) => void;
let container: HTMLDivElement, root: Root;
let animations: { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[];
let preloaded: string[];
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

/** The Compound panel's wiring in miniature: the click only starts the send; confirmation sets "success".
 *  `holdUntilDismissed` stands in for the app result dialog still being open. */
function Harness({ holdUntilDismissed = false, symbols = ["NVDAx", "USDC"] }: { holdUntilDismissed?: boolean; symbols?: string[] }) {
  const [feedback, set] = useState<Feedback>(null);
  useLayoutEffect(() => { setFeedback = set; }, []);
  const button = useRef<HTMLButtonElement>(null);
  const play = useCompoundCelebration(feedback, holdUntilDismissed && feedback !== null, symbols);
  return <div data-celebration-surface="" data-testid="surface">
    <section>
      <button ref={button} type="button" onClick={() => set({ phase: "submitting", signature: "" })}>One-click compound</button>
      <CompoundTokenBurst play={play} originRef={button} />
    </section>
  </div>;
}
const burst = () => container.querySelector<HTMLElement>('[data-testid="compound-token-burst"]');
const coinImages = () => [...container.querySelectorAll<HTMLImageElement>("[data-coin] img")].map((image) => image.getAttribute("src"));
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  animations = []; preloaded = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-celebration-surface")) return rect(0, -500, 1000, 3000);
    if (this.tagName === "BUTTON") return rect(100, 300, 200, 40);
    return rect(0, 0, 0, 0);
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, writable: true, value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { target: this, keyframes, options, cancel: vi.fn() };
    animations.push(animation);
    return animation as unknown as Animation;
  } });
  vi.stubGlobal("Image", class { decoding = ""; set src(value: string) { preloaded.push(value); } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("compound success coin burst", () => {
  it("does not burst on click or while confirming, bursts on a confirmed success, and is gone after the play", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => setFeedback({ phase: "confirming", signature: "sig1" }));
    expect(burst()).toBeNull();
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()).not.toBeNull();
    expect(burst()!.getAttribute("aria-hidden")).toBe("true");
    expect(burst()!.className).toContain("pointer-events-none");
    // Clipped to the content area, in its own coordinates (below the nav).
    expect(burst()!.parentElement).toBe(container.querySelector('[data-testid="surface"]'));
    await advance(CELEBRATION_MS + 10);
    expect(burst()).toBeNull();
  });

  it("waits for the result dialog to close, then bursts; closing a failed or unconfirmed dialog never does", async () => {
    await act(async () => root.render(createElement(Harness, { holdUntilDismissed: true })));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()).toBeNull();
    // The coins are chosen and preloaded while the dialog is still open.
    expect(preloaded.length).toBeGreaterThan(0);
    await act(async () => setFeedback(null));
    expect(burst()).not.toBeNull();
    await advance(CELEBRATION_MS + 10);
    await act(async () => setFeedback({ phase: "failed", signature: "sig2" }));
    await act(async () => setFeedback(null));
    await act(async () => setFeedback({ phase: "confirming", signature: "sig3" }));
    await act(async () => setFeedback(null));
    expect(burst()).toBeNull();
  });

  it("bursts once per signature, and a new confirmation restarts it", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(CELEBRATION_MS + 10);
    await act(async () => setFeedback(null));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()).toBeNull();
    await act(async () => setFeedback({ phase: "success", signature: "sig2" }));
    expect(burst()).not.toBeNull();
  });

  it("flies 14 coins, half of them the position's own stock, from the button; the button wobbles first", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    const images = coinImages();
    expect(images).toHaveLength(14);
    expect(images.filter((src) => src === STOCK_COIN_LOGOS.NVDA)).toHaveLength(7);
    // Same coins as preloaded.
    expect(new Set(images)).toEqual(new Set(preloaded));
    // Coins start centred on the button (200, 320 in viewport → 200, 820 in the content area).
    const first = container.querySelector<HTMLElement>("[data-coin]")!;
    const size = parseFloat(first.style.width);
    expect(parseFloat(first.style.left) + size / 2).toBeCloseTo(200, 6);
    expect(parseFloat(first.style.top) + size / 2).toBeCloseTo(820, 6);
    const button = container.querySelector("button")!;
    const wobble = animations.filter((animation) => animation.target === button);
    expect(wobble).toHaveLength(1);
    expect(wobble[0]!.keyframes).toEqual([...WOBBLE_KEYFRAMES]);
    // Each coin: one travel/fade animation on the coin and one turn on its 3D layer, after the wobble's burst delay.
    expect(animations.filter((animation) => (animation.target as HTMLElement).hasAttribute?.("data-coin"))).toHaveLength(14);
    expect(animations.filter((animation) => (animation.target as HTMLElement).hasAttribute?.("data-coin-turn"))).toHaveLength(14);
    expect(animations.every((animation) => animation.target === button || Number(animation.options.delay) >= 240)).toBe(true);
  });

  it("cancels its animations when it ends early on a resize", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(burst()).toBeNull();
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it("reduced motion: no wobble and no flight, three coins fade beside the button", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()?.getAttribute("data-celebration-reduced")).toBe("true");
    expect(coinImages()).toHaveLength(REDUCED_COINS);
    const button = container.querySelector("button")!;
    expect(animations.some((animation) => animation.target === button)).toBe(false);
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
