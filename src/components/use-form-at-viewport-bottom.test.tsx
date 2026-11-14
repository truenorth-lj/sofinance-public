// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFormAtViewportBottom } from "./use-form-at-viewport-bottom";

let container: HTMLDivElement, root: Root, form: HTMLDivElement;
let rect = { top: 0, bottom: 0, height: 0 };
function Probe({ enabled }: { enabled: boolean }) {
  return <span data-testid="bar">{String(useFormAtViewportBottom("deposit-view", enabled))}</span>;
}
const bar = () => container.querySelector("[data-testid=bar]")!.textContent;
const frame = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); };
async function scrollTo(next: typeof rect) { rect = next; await act(async () => { window.dispatchEvent(new Event("scroll")); }); await frame(); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerHeight", 800);
  form = document.createElement("div"); form.id = "deposit-view"; document.body.append(form);
  vi.spyOn(form, "getBoundingClientRect").mockImplementation(() => ({ ...rect, left: 0, right: 375, width: 375, x: 0, y: rect.top, toJSON() {} }) as DOMRect);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); form.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("stays hidden on load while the Add form is below the screen (the positions list fills it), then shows once the form's top is above the bar's area", async () => {
  rect = { top: 1400, bottom: 2200, height: 800 }; // the list is on screen, the form far below
  await act(async () => root.render(<Probe enabled />)); await frame();
  expect(bar()).toBe("false");
  await scrollTo({ top: 760, bottom: 1560, height: 800 }); // only 40 px of the form showing: the bar would cover the list above it
  expect(bar()).toBe("false");
  await scrollTo({ top: 680, bottom: 1480, height: 800 }); // the form's top is above the bar's 120 px: the bar covers only the form
  expect(bar()).toBe("true");
  await scrollTo({ top: -900, bottom: 600, height: 1500 }); // further down: still only the form and what follows it
  expect(bar()).toBe("true");
  await scrollTo({ top: 1400, bottom: 2200, height: 800 }); // back up to the list: hidden again
  expect(bar()).toBe("false");
});

it("never shows for another tab or a hidden form", async () => {
  rect = { top: 300, bottom: 1100, height: 800 };
  await act(async () => root.render(<Probe enabled={false} />)); await frame();
  expect(bar()).toBe("false");
  form.hidden = true;
  await act(async () => root.render(<Probe enabled />)); await frame();
  expect(bar()).toBe("false");
});
