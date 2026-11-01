// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTICE_BOTTOM_OFFSET_VAR, useNoticeBottomOffset } from "./notice-offset";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Bar({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useNoticeBottomOffset(ref, active);
  return <div ref={ref} data-testid="bar" />;
}
const offset = () => document.documentElement.style.getPropertyValue(NOTICE_BOTTOM_OFFSET_VAR);
let root: Root; let container: HTMLElement;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); document.documentElement.style.removeProperty(NOTICE_BOTTOM_OFFSET_VAR); });

describe("useNoticeBottomOffset", () => {
  it("publishes the fixed bar's height so toasts sit above it, and clears it when the bar goes away", () => {
    act(() => root.render(<Bar active />));
    const bar = container.querySelector<HTMLElement>("[data-testid=bar]")!;
    bar.getBoundingClientRect = () => ({ height: 72.4 }) as DOMRect;
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(offset()).toBe("73px");
    act(() => root.render(<Bar active={false} />));
    expect(offset()).toBe("");
  });
  it("sets nothing while inactive", () => {
    act(() => root.render(<Bar active={false} />));
    expect(offset()).toBe("");
  });
});
