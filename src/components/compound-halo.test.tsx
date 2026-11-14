// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompoundSuccessHalo, HALO_PREVIEW_EVENT, useCompoundSuccessHalo } from "./compound-halo";

type Feedback = { phase: "submitting" | "confirming" | "success" | "failed"; signature: string } | null;
let setFeedback: (next: Feedback) => void;
let draws: number;
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
  draws = 0;
  const context = new Proxy({}, { get: (_target, key) => (key === "createRadialGradient" ? () => ({ addColorStop: () => {} })
    : key === "clearRect" ? () => { draws++; } : () => {}), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
