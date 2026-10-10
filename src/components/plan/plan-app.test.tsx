// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionContext, type WalletConnection } from "../wallet-connection";
import { PlanApp } from "./plan-app";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";

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

function aprPayload(aprPct: number | null = 36.5) {
  return {
    poolId: POOL,
    points: [
      { time: 1_791_417_600, date: "2026-10-08", aprPct, volumeUsd: 1_000, tvlUsd: 10_000 },
      { time: 1_791_504_000, date: "2026-10-09", aprPct, volumeUsd: 1_000, tvlUsd: 10_000 },
    ],
    fetchedAt: "2026-10-10T00:00:00.000Z",
  };
}

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

async function waitForText(snippet: string) {
  await act(async () => {
    for (let i = 0; i < 40; i++) {
      if (text().includes(snippet)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  expect(text()).toContain(snippet);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/pool-daily-apr")) {
      return { ok: true, json: async () => aprPayload() };
    }
    throw new Error(`unexpected ${url}`);
  });
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
  it("shows an unavailable chart and does not invent yield when no pool is chosen", async () => {
    await render();
    expect(text()).toContain("No pool chosen, so there is no estimate yet.");
    expect(text()).toContain("Choose a pool to estimate SoFinance against simply holding");
    expect(text()).toContain("Estimate from past average yield, not a forecast");
    expect(text()).not.toContain("Sideways");
    expect(text()).not.toContain("Gap down");
    expect(text()).not.toContain("sample paths");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("explains a pair-only link instead of fabricating a pool", async () => {
    await render("pair=SPCXx%2FSPCX");
    expect(text()).toContain("Pair SPCXx/SPCX");
    expect(text()).toContain("This link names a pair but has no pool id");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads the pool average once and plots SoFinance against a flat hold", async () => {
    await render(`pool=${POOL}&pair=SPCXx%2FSPCX`);
    await waitForText("Past average 36.5% a year");
    expect(text()).toMatch(/Pool\s+SPCXx\/SPCX/);
    expect(text()).toContain("SoFinance vs hold");
    expect(text()).toContain("vs hold");
    expect(text()).toContain("Break-even");
    expect(text()).toContain("Day 0 — no entry cost is counted");
    expect(text()).not.toContain("Sideways");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain(`/api/pool-daily-apr?poolId=${POOL}`);
  });

  it("updates the chart from the slider without refetching", async () => {
    await render(`pool=${POOL}&target=100`);
    await waitForText("Past average 36.5% a year");
    const before = fetcher.mock.calls.length;
    const slider = node.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute("aria-label")).toBe("Target gain as a share of the amount");
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(text()).toContain("+75 USDC");
    expect(text()).toContain("aim +75");
    expect(fetcher.mock.calls.length).toBe(before);
  });

  it("offers a longer horizon from the yield math and applies it only when asked", async () => {
    await render(`pool=${POOL}&days=1&target=3`);
    await waitForText("Give it 3 days");
    expect(text()).toContain("In 1 day");
    await click("Give it 3 days");
    expect(text()).toContain("In 3 days");
    expect(text()).toContain("on your aim");
  });

  it("opens with a plan carried in the link", async () => {
    await render(`pool=${POOL}&amount=5000&days=90&goal=beat-holding&edit=goal`);
    await waitForText("Past average 36.5% a year");
    expect(text()).toContain("In 90 days");
    expect(text()).toContain("5,000 USDC");
    expect(text()).toContain("beat holding by");
    expect(node.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Hold and collect fees");
  });

  it("stays unavailable when the series has no complete days", async () => {
    fetcher.mockImplementation(async () => ({ ok: true, json: async () => aprPayload(null) }));
    await render(`pool=${POOL}`);
    await waitForText("No complete UTC days");
    expect(text()).not.toContain("Past average");
    expect(text()).toContain("No average yield for this pool.");
  });
});
