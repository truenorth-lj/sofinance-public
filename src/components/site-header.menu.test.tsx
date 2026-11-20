// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/learn" }));

import { SiteHeader } from "./site-header";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(variant: "marketing" | "app") {
  await act(async () => {
    root.render(createElement(SiteHeader, { variant }));
  });
}

describe("SiteHeader mobile menu", () => {
  it("keeps AI agents in the marketing Menu and does not drop it below 640px", async () => {
    await render("marketing");
    const menu = container.querySelector<HTMLButtonElement>("[data-testid=nav-menu]")!;
    const nav = container.querySelector("nav")!;
    expect(menu).not.toBeNull();
    expect(nav.getAttribute("aria-label")).toBe("Sections");
    expect(nav.className).toContain("hidden");
    await act(async () => { menu.click(); });
    const labels = [...nav.querySelectorAll("a")].map((a) => a.textContent);
    expect(labels).toEqual(["Pools", "Portfolio", "Learn", "AI agents", "Blog"]);
    expect(nav.className).toContain("grid");
    expect([...nav.querySelectorAll("a")].every((a) => !a.className.includes("sm:flex") || !a.className.includes("hidden"))).toBe(true);
  });

  it("opens the same Menu on app pages without Blog", async () => {
    await render("app");
    const menu = container.querySelector<HTMLButtonElement>("[data-testid=nav-menu]")!;
    const nav = container.querySelector('nav[aria-label="App"]')!;
    await act(async () => { menu.click(); });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Pools", "Portfolio", "Learn", "AI agents"]);
    await act(async () => { nav.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(nav.className).toContain("hidden");
  });

  it("at 375 the mobile row is logo first and Menu last (order classes are sm: only)", async () => {
    await render("marketing");
    const header = container.querySelector<HTMLElement>("[data-testid=site-header]")!;
    const row = header.querySelector(":scope > div")!;
    const children = [...row.children] as HTMLElement[];
    const logo = children[0];
    const trailing = children[1];
    expect(logo).toBeDefined();
    expect(trailing).toBeDefined();
    if (!logo || !trailing) throw new Error("mobile row must have logo then wallet+Menu");
    // DOM order is the visual order below sm: an un-prefixed order-1 on the logo would sort it after
    // the wallet group (default order 0) once sm:contents is not applied.
    expect(logo.getAttribute("href")).toBe("/");
    expect(logo.textContent).toContain("SoFinance");
    expect(logo.className.split(/\s+/)).not.toContain("order-1");
    expect(logo.className).toContain("sm:order-1");
    expect(trailing.className).toContain("ml-auto");
    expect(trailing.className).toContain("sm:order-3");
    expect(trailing.className.split(/\s+/)).not.toContain("order-1");
    const trailingKids = [...trailing.children] as HTMLElement[];
    const menu = trailing.querySelector<HTMLElement>("[data-testid=nav-menu]")!;
    expect(menu).not.toBeNull();
    expect(trailingKids.at(-1)).toBe(menu);
    // Left-to-right in the header row: logo, then the trailing group that ends with Menu.
    const tree = [...header.querySelectorAll("a, button")].filter((el) => {
      const nav = el.closest("nav");
      return !nav || !nav.className.split(/\s+/).includes("hidden");
    });
    expect(tree[0]).toBe(logo);
    expect(tree.at(-1)).toBe(menu);
  });
});
