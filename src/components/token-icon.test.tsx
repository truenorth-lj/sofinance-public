// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenIcon, tokenInitial } from "./token-icon";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
// happy-dom reports every image as complete; model a browser: still loading unless a test settles it.
const imageState = { complete: false, naturalWidth: 0, decode: () => Promise.resolve() };
beforeEach(() => {
  Object.assign(imageState, { complete: false, naturalWidth: 0, decode: () => Promise.resolve() });
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockImplementation(() => imageState.complete);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(() => imageState.naturalWidth);
  HTMLImageElement.prototype.decode = function decode() { return imageState.decode(); };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  container.remove();
});

const fallback = () => container.querySelector("[data-testid='token-icon-fallback']")?.textContent ?? null;

describe("TokenIcon", () => {
  it("uses the token's first letter as the fallback (LJ's rule)", () => {
    expect(tokenInitial("SNDKx")).toBe("S");
    expect(tokenInitial("usdc")).toBe("U");
    expect(tokenInitial(" ")).toBe("?");
  });

  it("shows the first letter without an icon", async () => {
    await act(async () => root.render(createElement(TokenIcon, { symbol: "SNDKx", icon: null })));
    expect(fallback()).toBe("S");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the letter while the icon loads, hides it once loaded, and brings it back when the icon fails", async () => {
    await act(async () => root.render(createElement(TokenIcon, { symbol: "USDC", icon: "https://example.test/usdc.png" })));
    const img = container.querySelector("img")!;
    expect(fallback()).toBe("U"); // never a blank circle while loading
    await act(async () => img.dispatchEvent(new Event("load")));
    expect(fallback()).toBeNull();
    expect(img.className).toContain("opacity-100");

    await act(async () => root.render(createElement(TokenIcon, { symbol: "USDT", icon: "https://example.test/broken.png" })));
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(fallback()).toBe("U");
  });

  it("catches an image that failed before hydration (no onError fired) and shows the letter", async () => {
    Object.assign(imageState, { complete: true, naturalWidth: 0, decode: () => Promise.reject(new Error("broken")) });
    await act(async () => root.render(createElement(TokenIcon, { symbol: "SNDK", icon: "https://example.test/sndk.svg" })));
    await act(async () => {});
    expect(container.querySelector("img")).toBeNull();
    expect(fallback()).toBe("S");
  });

  it("treats an image that loaded before hydration as loaded", async () => {
    Object.assign(imageState, { complete: true, naturalWidth: 18 });
    await act(async () => root.render(createElement(TokenIcon, { symbol: "SNDK", icon: "https://example.test/sndk.svg" })));
    expect(fallback()).toBeNull();
  });
});
