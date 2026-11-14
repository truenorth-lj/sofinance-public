// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OK_RELEASE_KEYFRAMES, OK_RELEASE_MS } from "@/lib/compound-celebration/coins";
import { CompoundSubmitDialog } from "./compound-submit-dialog";
import type { CompoundSubmitFeedback } from "./use-compound-controller";

let container: HTMLDivElement, root: Root;
let animated: { target: Element; keyframes: Keyframe[] }[];
const success = { phase: "success", signature: "sig1" } as CompoundSubmitFeedback;
const failed = { phase: "failed", signature: "sig2", message: "Simulation failed" } as CompoundSubmitFeedback;
const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  animated = [];
  Object.defineProperty(Element.prototype, "animate", { configurable: true, writable: true, value(this: Element, keyframes: Keyframe[]) {
    animated.push({ target: this, keyframes });
    return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
  } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() =>
    ({ left: 560, top: 600, width: 160, height: 48, right: 720, bottom: 648, x: 560, y: 600, toJSON() {} }) as DOMRect);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("Compound confirmed OK", () => {
  it("shrinks while pressed (motion-safe) and is the dialog's default focus", async () => {
    await act(async () => root.render(createElement(CompoundSubmitDialog, { feedback: success, onDismiss: () => {}, onCelebrate: () => {} })));
    expect(button("OK").className).toContain("motion-safe:active:scale-[0.94]");
    expect(button("OK").className).toContain("transition-transform");
  });

  it("on release: hands its box to the coins at once, pops back, then closes the dialog", async () => {
    const onDismiss = vi.fn(), onCelebrate = vi.fn();
    await act(async () => root.render(createElement(CompoundSubmitDialog, { feedback: success, onDismiss, onCelebrate })));
    await act(async () => button("OK").click());
    expect(onCelebrate).toHaveBeenCalledTimes(1);
    expect(onCelebrate.mock.calls[0]![0]).toMatchObject({ left: 560, top: 600, width: 160, height: 48 });
    expect(animated).toHaveLength(1);
    expect(animated[0]!.target).toBe(button("OK"));
    expect(animated[0]!.keyframes).toEqual([...OK_RELEASE_KEYFRAMES]);
    expect(onDismiss).not.toHaveBeenCalled();
    // A second click during the pop does nothing more.
    await act(async () => button("OK").click());
    expect(onCelebrate).toHaveBeenCalledTimes(1);
    await advance(OK_RELEASE_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("without coins to release (no onCelebrate), OK closes at once as before", async () => {
    const onDismiss = vi.fn();
    await act(async () => root.render(createElement(CompoundSubmitDialog, { feedback: success, onDismiss })));
    await act(async () => button("OK").click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(animated).toHaveLength(0);
  });

  it("a failed compound's Close never releases coins and closes at once", async () => {
    const onDismiss = vi.fn(), onCelebrate = vi.fn();
    await act(async () => root.render(createElement(CompoundSubmitDialog, { feedback: failed, onDismiss, onCelebrate })));
    await act(async () => button("Close").click());
    expect(onCelebrate).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("reduced motion: the coins still get the release, but there is no pop and the dialog closes at once", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    const onDismiss = vi.fn(), onCelebrate = vi.fn();
    await act(async () => root.render(createElement(CompoundSubmitDialog, { feedback: success, onDismiss, onCelebrate })));
    await act(async () => button("OK").click());
    expect(onCelebrate).toHaveBeenCalledTimes(1);
    expect(animated).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
