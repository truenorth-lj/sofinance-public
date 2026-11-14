// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CELEBRATION_MS, FALL_MS, REDUCED_COINS, REDUCED_MS, STAGGER_MS, STOCK_COIN_LOGOS } from "@/lib/compound-celebration/coins";
import { CELEBRATION_PREVIEW_EVENT, CompoundTokenBurst, celebrationPreviewEnabled, useCompoundCelebration } from "./compound-celebration";

type Feedback = { phase: "submitting" | "confirming" | "success" | "failed"; signature: string } | null;
let setFeedback: (next: Feedback) => void;
let celebrateFrom: (origin: DOMRect) => void;
let container: HTMLDivElement, root: Root;
let animations: { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[];
let preloaded: string[];
let popovers: number;
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

/** The Compound panel's wiring in miniature: the click only starts the send; confirmation sets "success".
 *  `holdUntilDismissed` stands in for the app result dialog still being open. */
function Harness({ holdUntilDismissed = false, symbols = ["NVDAx", "USDC"] }: { holdUntilDismissed?: boolean; symbols?: string[] }) {
  const [feedback, set] = useState<Feedback>(null);
  const button = useRef<HTMLButtonElement>(null);
  const celebration = useCompoundCelebration(feedback, holdUntilDismissed && feedback !== null, symbols);
  useLayoutEffect(() => { setFeedback = set; celebrateFrom = celebration.celebrateFrom; }, [celebration.celebrateFrom]);
  return <section>
    <button ref={button} type="button" onClick={() => set({ phase: "submitting", signature: "" })}>One-click compound</button>
    <CompoundTokenBurst play={celebration.play} originRef={button} />
  </section>;
}
const burst = () => document.querySelector<HTMLElement>('[data-testid="compound-token-burst"]');
const coins = () => [...document.querySelectorAll<HTMLElement>("[data-coin]")];
const coinImages = () => coins().map((coin) => coin.querySelector("img")!.getAttribute("src"));
/** Where a coin starts (its centre), in viewport px. */
const start = (coin: HTMLElement) => ({ x: parseFloat(coin.style.left) + parseFloat(coin.style.width) / 2, y: parseFloat(coin.style.top) + parseFloat(coin.style.height) / 2 });
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  animations = []; preloaded = []; popovers = 0;
  vi.stubGlobal("innerWidth", 1280); vi.stubGlobal("innerHeight", 900);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
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
  it("does not play on click or while confirming, plays on a confirmed success, and is gone after the play", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => setFeedback({ phase: "confirming", signature: "sig1" }));
    expect(burst()).toBeNull();
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
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

  it("holds the success while the dialog is open, then the OK release pops the coins out of the OK button, once", async () => {
    await act(async () => root.render(createElement(Harness, { holdUntilDismissed: true })));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()).toBeNull();
    // Chosen and preloaded while the dialog is open.
    expect(preloaded.length).toBeGreaterThan(0);
    await act(async () => celebrateFrom(rect(560, 600, 160, 48)));
    expect(burst()).not.toBeNull();
    for (const coin of coins()) { expect(start(coin).x).toBeCloseTo(640, 3); expect(start(coin).y).toBeCloseTo(624, 3); }
    expect(new Set(coinImages())).toEqual(new Set(preloaded));
    // The dialog closes a moment later: that must not start a second play.
    const before = animations.length;
    await act(async () => setFeedback(null));
    expect(animations.length).toBe(before);
    await advance(CELEBRATION_MS + 10);
    expect(burst()).toBeNull();
    await act(async () => celebrateFrom(rect(560, 600, 160, 48)));
    expect(burst()).toBeNull();
  });

  it("closing the dialog another way (Escape) still plays it, from the Compound button", async () => {
    await act(async () => root.render(createElement(Harness, { holdUntilDismissed: true })));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await act(async () => setFeedback(null));
    expect(burst()).not.toBeNull();
    expect(coins().length).toBeGreaterThan(0);
    for (const coin of coins()) { expect(start(coin).x).toBeCloseTo(200, 3); expect(start(coin).y).toBeCloseTo(320, 3); }
  });

  it("closing a failed or unconfirmed dialog never plays, and OK has nothing to release then", async () => {
    await act(async () => root.render(createElement(Harness, { holdUntilDismissed: true })));
    await act(async () => setFeedback({ phase: "failed", signature: "sig2" }));
    await act(async () => celebrateFrom(rect(560, 600, 160, 48)));
    await act(async () => setFeedback(null));
    await act(async () => setFeedback({ phase: "confirming", signature: "sig3" }));
    await act(async () => setFeedback(null));
    expect(burst()).toBeNull();
  });

  it("plays once per signature, and a new confirmation restarts it", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(CELEBRATION_MS + 10);
    await act(async () => setFeedback(null));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()).toBeNull();
    await act(async () => setFeedback({ phase: "success", signature: "sig2" }));
    expect(burst()).not.toBeNull();
  });

  it("drops 14 coins, half of them the position's own stock, each with a fall and a wobble animation", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(coinImages()).toHaveLength(14);
    expect(coinImages().filter((src) => src === STOCK_COIN_LOGOS.NVDA)).toHaveLength(7);
    const falls = animations.filter((animation) => (animation.target as HTMLElement).hasAttribute?.("data-coin"));
    const turns = animations.filter((animation) => (animation.target as HTMLElement).hasAttribute?.("data-coin-turn"));
    expect(falls).toHaveLength(14);
    expect(turns).toHaveLength(14);
    for (const animation of [...falls, ...turns]) {
      expect(animation.options.duration).toBe(FALL_MS);
      expect(Number(animation.options.delay)).toBeLessThanOrEqual(STAGGER_MS);
      expect(animation.keyframes[0]!.offset).toBe(0);
      expect(animation.keyframes.at(-1)!.offset).toBe(1);
    }
    expect(falls.every((animation) => animation.keyframes.at(-1)!.opacity === 0)).toBe(true);
  });

  it("cancels its animations when it ends early on a resize", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(burst()).toBeNull();
    expect(animations.length).toBeGreaterThan(0);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it("reduced motion: no pop and no fall, three coins fade beside the origin", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    expect(burst()?.getAttribute("data-celebration-reduced")).toBe("true");
    expect(coinImages()).toHaveLength(REDUCED_COINS);
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
