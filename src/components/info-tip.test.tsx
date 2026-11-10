// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InfoTip } from "./info-tip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("InfoTip", () => {
  it.each([["below", "top left", "-4px"], ["above", "bottom left", "4px"]] as const)(
    "grows out of its ⓘ when shown %s (not a pop-in)", (placement, origin, from) => {
      act(() => root.render(<InfoTip label="About" placement={placement}>Help text</InfoTip>));
      act(() => { host.querySelector("button")!.focus(); });
      const tip = host.querySelector<HTMLElement>("[role=tooltip]")!;
      expect(tip.textContent).toBe("Help text");
      expect(tip.className).toContain("motion-safe:animate-emerge");
      expect(tip.style.transformOrigin).toBe(origin);
      expect(tip.style.getPropertyValue("--emerge-from")).toBe(from);
    });
});
