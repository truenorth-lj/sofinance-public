// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHaloMask, CompoundSuccessHalo, HALO_PREVIEW_EVENT, haloPreviewEnabled, useCompoundSuccessHalo } from "./compound-halo";

type Feedback = { phase: "submitting" | "confirming" | "success" | "failed"; signature: string } | null;
let setFeedback: (next: Feedback) => void;
let draws: number;
let calls: string[];
/** Layout stand-ins (happy-dom has no layout): a 3000 px content area scrolled 500 px down in a 1024 × 768 viewport. */
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
let container: HTMLDivElement, root: Root;

/** The Compound panel's wiring in miniature: the button click only starts the send; confirmation sets "success". */
function Harness() {
  const [feedback, set] = useState<Feedback>(null);
  useLayoutEffect(() => { setFeedback = set; }, []);
  const button = useRef<HTMLButtonElement>(null);
  const play = useCompoundSuccessHalo(feedback);
  return <div data-halo-surface="" data-testid="surface">
    <section>
      <button ref={button} type="button" onClick={() => set({ phase: "submitting", signature: "" })}>One-click compound</button>
      <CompoundSuccessHalo play={play} originRef={button} />
    </section>
  </div>;
}
const halo = () => container.querySelector('[data-testid="compound-halo"]');
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  draws = 0; calls = [];
  const context = new Proxy({}, { get: (_target, key) => (key === "createRadialGradient" ? () => ({ addColorStop: () => {} })
    : key === "clearRect" ? () => { draws++; } : (...args: unknown[]) => { calls.push(`${String(key)}:${args.map((a) => a instanceof HTMLImageElement ? "img" : String(a)).join(",")}`); }),
  set: () => true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-halo-surface")) return rect(0, -500, 1000, 3000);
    if (this.tagName === "BUTTON") return rect(100, 300, 200, 40);
    return rect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("compound success halo canvas", () => {
  it("sizes the canvas to the visible slice (content area ∩ viewport) at device pixels capped at 2", async () => {
    vi.stubGlobal("devicePixelRatio", 3);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(16);
    const canvas = container.querySelector<HTMLCanvasElement>('[data-testid="compound-halo-canvas"]')!;
    expect([canvas.style.left, canvas.style.top, canvas.style.width, canvas.style.height]).toEqual(["0px", "500px", "1000px", "768px"]);
    expect([canvas.width, canvas.height]).toEqual([2000, 1536]);
  });

  it("a window resize ends the run and removes the overlay", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(100);
    expect(halo()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(halo()).toBeNull();
  });

  it("clears the mask canvas when the run ends", async () => {
    const made: HTMLCanvasElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (tag === "canvas") made.push(element as HTMLCanvasElement);
      return element;
    }) as typeof document.createElement);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(100);
    expect(made.some((mask) => mask.width > 0)).toBe(true);
    await advance(1000);
    expect(halo()).toBeNull();
    expect(made.map((mask) => mask.width)).toEqual(made.map(() => 0));
  });

  it("masks inline SVG icons by their shape, never by filling their bounding box", async () => {
    const surface = document.createElement("div");
    surface.innerHTML = `<svg viewBox="0 0 24 24" style="fill: none; stroke: rgb(1, 2, 3)"><path d="M12 5v14" style="fill: none; stroke: rgb(1, 2, 3)"></path><circle cx="4" cy="4" r="2" style="fill: rgb(9, 9, 9); stroke: none"></circle></svg>`;
    document.body.append(surface);
    const svg = surface.querySelector("svg")!;
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(function (this: SVGElement) {
      return this === svg ? rect(40, 60, 16, 16) : rect(0, 0, 0, 0);
    });
    const sources: string[] = [];
    const setSrc = vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (value: string) { sources.push(value); });
    const mask = await buildHaloMask(surface, { left: 0, top: 0, width: 200, height: 200 }, 2);
    expect(mask).not.toBeNull();
    expect(calls.filter((call) => call.startsWith("fillRect"))).toEqual([]);
    expect(calls).toContain("drawImage:img,40,60,16,16");
    const markup = decodeURIComponent(sources[0]!.replace("data:image/svg+xml;charset=utf-8,", ""));
    // The stroke-only path stays a stroke (no filled blob); the filled dot stays filled; everything is solid black.
    expect(markup).toMatch(/<path[^>]*fill="none"[^>]*stroke="#000"/);
    expect(markup).toMatch(/<circle[^>]*fill="#000"[^>]*stroke="none"/);
    expect(markup).not.toContain("rgb(");
    setSrc.mockRestore(); surface.remove();
  });
});

describe("halo preview hook", () => {
  it("is off in production builds unless NEXT_PUBLIC_HALO_PREVIEW=1", () => {
    expect(haloPreviewEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(haloPreviewEnabled({ NODE_ENV: "production", NEXT_PUBLIC_HALO_PREVIEW: "0" })).toBe(false);
    expect(haloPreviewEnabled({ NODE_ENV: "production", NEXT_PUBLIC_HALO_PREVIEW: "1" })).toBe(true);
    expect(haloPreviewEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(haloPreviewEnabled({ NODE_ENV: "test" })).toBe(true);
  });
});

describe("compound success halo trigger", () => {
  it("does not play on click or while confirming; plays once the transaction is confirmed successful", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => container.querySelector("button")!.click());
    await advance(50);
    expect(halo()).toBeNull();
    await act(async () => setFeedback({ phase: "confirming", signature: "sig1" }));
    await advance(50);
    expect(halo()).toBeNull();
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(16);
    expect(halo()).not.toBeNull();
    expect(halo()!.parentElement!.getAttribute("data-testid")).toBe("surface");
    expect(halo()!.className).toContain("pointer-events-none");
    expect(halo()!.getAttribute("aria-hidden")).toBe("true");
    expect(draws).toBeGreaterThan(0);
  });

  it("removes the overlay at rest after the 1000 ms play, and the same signature never plays again", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(500);
    expect(halo()).not.toBeNull();
    await advance(600);
    expect(halo()).toBeNull();
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(16);
    expect(halo()).toBeNull();
  });

  it("a failed transaction never plays it", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "failed", signature: "sig1" }));
    await advance(50);
    expect(halo()).toBeNull();
  });

  it("restarts when another confirmed success arrives mid-play", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(700);
    await act(async () => setFeedback({ phase: "success", signature: "sig2" }));
    await advance(700);
    // 1400 ms after the first play: still running because the second one restarted the clock.
    expect(halo()).not.toBeNull();
    await advance(400);
    expect(halo()).toBeNull();
  });

  it("reduced motion fades in place over 600 ms", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    await act(async () => root.render(createElement(Harness)));
    await act(async () => setFeedback({ phase: "success", signature: "sig1" }));
    await advance(16);
    expect(halo()?.getAttribute("data-halo-reduced")).toBe("true");
    await advance(650);
    expect(halo()).toBeNull();
  });

  it("the visual preview event plays it without any transaction", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { window.dispatchEvent(new Event(HALO_PREVIEW_EVENT)); });
    await advance(16);
    expect(halo()).not.toBeNull();
  });
});
