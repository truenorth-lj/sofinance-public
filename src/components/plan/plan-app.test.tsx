// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionContext, type WalletConnection } from "../wallet-connection";
import { PlanApp } from "./plan-app";

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/app/plan",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

const wallet: WalletConnection = {
  connected: false,
  connect: () => {},
  disconnect: () => {},
  isMobile: false,
  walletsCount: 0,
  connectionError: "",
  signTransaction: async (transaction) => transaction,
};

let node: HTMLDivElement;
let root: Root;
const fetcher = vi.fn();

async function render(query = "") {
  search = query;
  await act(async () =>
    root.render(createElement(WalletConnectionContext.Provider, { value: wallet }, createElement(PlanApp))),
  );
}
const text = () => node.textContent ?? "";
async function click(label: string) {
  const button = [...node.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!button) throw new Error(`No button: ${label}`);
  await act(async () => button.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});

describe("PlanApp", () => {
  it("shows no outcome numbers until sample paths are switched on", async () => {
    await render();
    expect(text()).toContain("No verified forecast for this plan yet.");
    expect(text()).not.toContain("USDC net of costs");
    expect(text()).not.toContain("sample paths.");

    await click("Preview on sample paths");
    expect(text()).toContain("Out of reach in all 3 sample paths.");
    expect(text()).toContain("+2.65");
    expect(text()).toContain("Sample paths are synthetic and carry no probabilities.");
  });

  it("offers a longer horizon instead of bending the plan, and applies it only when asked", async () => {
    await render("sample=1");
    expect(text()).toContain("In 30 days");
    await click("Give it 207 days");
    expect(text()).toContain("In 207 days");
    expect(text()).toContain("On target in 1 of 3 sample paths.");
  });

  it("moves one condition at a time from the keyboard and re-judges the plan", async () => {
    await render("sample=1");
    const slider = node.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute("aria-label")).toBe("Target gain as a share of the amount");
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(text()).toContain("+20 USDC");
    expect(text()).toContain("17.35 USDC short of your target.");
  });

  it("opens with a plan carried in the link and judges beat-holding against the basket", async () => {
    await render("sample=1&amount=5000&days=90&goal=beat-holding&edit=goal");
    expect(text()).toContain("In 90 days");
    expect(text()).toContain("5,000 USDC");
    expect(text()).toContain("beat holding by");
    expect(text()).toContain("USDC vs holding");
    expect(node.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Hold and collect fees");
  });

  it("stays read-only: planning never touches the network", async () => {
    await render("sample=1");
    await click("Aim for +2.64 instead");
    expect(text()).toContain("On target in 1 of 3 sample paths.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
