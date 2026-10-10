// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionContext, type WalletConnection } from "../wallet-connection";
import { PlanApp } from "./plan-app";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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

function pairsPayload() {
  return {
    pairs: [
      { poolAddress: POOL, wrappedSymbol: "SPCXx", plainSymbol: "SPCX" },
      { poolAddress: OTHER, wrappedSymbol: "MSTRx", plainSymbol: "MSTR" },
    ],
    scannedPools: 2,
    pagesFetched: 1,
    fetchedAt: "2026-10-10T00:00:00.000Z",
    pairingRuleSummary: "test",
    estimatedFeeAprLabel: "test",
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
  for (let i = 0; i < 80; i++) {
    if (text().includes(snippet)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
  expect(text()).toContain(snippet);
}

async function setAmount(value: string) {
  const amountPill = [...node.querySelectorAll("button")].find((button) =>
    /^\s*[\d,.]+ USDC/.test(button.textContent ?? ""),
  );
  if (!amountPill) throw new Error("amount pill missing");
  await act(async () => amountPill.click());
  const input = node.querySelector<HTMLInputElement>('input[aria-label="Amount to put in, in USDC"]');
  if (!input) throw new Error("amount input missing");
  const assign = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    assign?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/rwa-pairs")) {
      return { ok: true, json: async () => pairsPayload() };
    }
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
  it("defaults to the SPCXx/SPCX pool and a +100 USDC aim when nothing is chosen", async () => {
    await render();
    await waitForText("Past average 36.5% a year");
    expect(text()).toContain("+100 USDC");
    expect(text()).toContain("10%");
    expect(text()).toContain("break-even day 1");
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="Pool"]')?.value).toBe(POOL);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/rwa-pairs"))).toBe(true);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes(`/api/pool-daily-apr?poolId=${POOL}`))).toBe(true);
  });

  it("resolves a pair-only link from the cached RWA list", async () => {
    await render("pair=MSTRx%2FMSTR");
    await waitForText("Past average 36.5% a year");
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="Pool"]')?.value).toBe(OTHER);
    expect(
      fetcher.mock.calls.some((call) => String(call[0]).includes(`/api/pool-daily-apr?poolId=${OTHER}`)),
    ).toBe(true);
  });

  it("explains an unknown pair-only link instead of fabricating a pool", async () => {
    await render("pair=NVDAx%2FNVDA");
    await waitForText("This link names a pair but has no pool id");
    expect(text()).not.toContain("Past average");
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/pool-daily-apr"))).toBe(false);
  });

  it("loads the pool average once and plots SoFinance against a flat hold", async () => {
    await render(`pool=${POOL}&pair=SPCXx%2FSPCX`);
    await waitForText("Past average 36.5% a year");
    expect(text()).toContain("SoFinance vs hold");
    expect(text()).toContain("Break-even");
    expect(text()).toContain("Day 1 — after the protocol swap fee");
    expect(text()).toContain("Estimated earn");
    expect(text()).not.toContain("Sideways");
    expect(fetcher.mock.calls.filter((call) => String(call[0]).includes("/api/pool-daily-apr"))).toHaveLength(1);
  });

  it("updates the chart from the slider without refetching", async () => {
    await render(`pool=${POOL}&target=100`);
    await waitForText("Past average 36.5% a year");
    const before = fetcher.mock.calls.filter((call) => String(call[0]).includes("/api/pool-daily-apr")).length;
    const slider = node.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute("aria-label")).toBe("Target gain as a share of the amount");
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(text()).toContain("+75 USDC");
    expect(text()).toContain("aim +75");
    expect(fetcher.mock.calls.filter((call) => String(call[0]).includes("/api/pool-daily-apr")).length).toBe(before);
  });

  it("lets a click on the far right of the ruler reach the last stop", async () => {
    await render(`pool=${POOL}&target=100`);
    await waitForText("Past average 36.5% a year");
    const slider = node.querySelector<HTMLElement>('[role="slider"]')!;
    const wrapper = slider.parentElement!;
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 200, right: 200, top: 0, bottom: 24, height: 24, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => {
      wrapper.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, bubbles: true }));
    });
    expect(text()).toContain("+500 USDC");
  });

  it("offers a longer horizon from the yield math and applies it only when asked", async () => {
    await render(`pool=${POOL}&days=1&target=3`);
    await waitForText("Give it 4 days");
    expect(text()).toContain("In 1 day");
    expect(text()).not.toContain("In 1 days");
    await click("Give it 4 days");
    expect(text()).toContain("In 4 days");
    expect(text()).toContain("on your aim");
  });

  it("rescales the loss alert when the amount goes 1 → 10,000", async () => {
    await render(`pool=${POOL}`);
    await waitForText("Past average 36.5% a year");
    expect(text()).toContain("50 USDC");
    await setAmount("1");
    expect(text()).toContain("0.05 USDC");
    await setAmount("10000");
    expect(text()).toContain("500 USDC");
    expect(text()).not.toMatch(/Warn me if I'm down 1 USDC/);
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
    fetcher.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/rwa-pairs")) return { ok: true, json: async () => pairsPayload() };
      return { ok: true, json: async () => aprPayload(null) };
    });
    await render(`pool=${POOL}`);
    await waitForText("No complete UTC days");
    expect(text()).not.toContain("Past average");
    expect(text()).toContain("No average yield for this pool.");
  });
});
