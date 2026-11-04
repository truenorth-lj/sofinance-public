// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareCalcDialog, type ShareCalcPool } from "./share-calc-dialog";
import type { OpenAction } from "./pool-list";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
const SPCX: ShareCalcPool = { poolAddress: POOL, pairLabel: "SPCXx/SPCX", protocol: "raydium-clmm" };
const STABLE: ShareCalcPool = { poolAddress: POOL, pairLabel: "USDC/USDT", protocol: "raydium-clmm" };
const DAY = 86_400;
const FIRST_DAY = 1_791_417_600;

/** 8 complete UTC days at a flat 36.5% fee APR (0.1% a day). */
const aprPayload = {
  poolId: POOL,
  points: Array.from({ length: 8 }, (_, i) => ({ time: FIRST_DAY + i * DAY, aprPct: 36.5, volumeUsd: 1_000, tvlUsd: 10_000 })),
  fetchedAt: "2026-12-31T00:00:00.000Z",
};

let node: HTMLDivElement;
let root: Root;
const fetcher = vi.fn();
const text = () => node.textContent ?? "";
const button = (label: string) => [...node.querySelectorAll("button")].find((b) => b.textContent === label)!;

async function render(pool: ShareCalcPool, open: OpenAction, onClose = vi.fn()) {
  await act(async () => root.render(createElement(ShareCalcDialog, { pool, open, onClose })));
  for (let i = 0; i < 60 && !node.querySelector("[data-testid=hodl-vs-pool]"); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
  }
  return onClose;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async () => ({ ok: true, json: async () => aprPayload }));
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});

describe("ShareCalcDialog", () => {
  it("compares HODL with HODL plus earned shares for a year by default, from the pool's daily APR", async () => {
    await render(SPCX, { kind: "open", onOpen: vi.fn() });
    expect(fetcher.mock.calls.some((call) => String(call[0]) === `/api/pool-daily-apr?poolId=${POOL}`)).toBe(true);
    const dialog = node.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Calculate shares for SPCXx/SPCX");
    expect(button("1Y").getAttribute("aria-pressed")).toBe("true");
    const cards = node.querySelector("[data-testid=hodl-vs-pool]")!;
    expect(cards.querySelector("h2")!.textContent).toBe("HODL vs. HODL + more shares");
    expect(cards.textContent).toContain("Collect more SPCX while you hold SPCX · $1,000 for 365 days");
    // 36.5% pool APR × 84% to LPs, one year, minus 1% to open and 1% to swap back to USDC = +335.14.
    expect(cards.querySelector('[aria-label="Difference"]')!.textContent).toContain("+$335.14");
    expect(node.querySelector("[data-testid=share-calc-footnote]")!.textContent)
      .toContain("fees after Raydium's 16% cut, about 1% to open, about 1% to swap back to USDC");
    // The calculator shows the chart without the Plan page's summary, APY line and method paragraph.
    expect(text()).not.toMatch(/read-only|per 100 held vs hold|Est\. best APY|Counted per 100/);
  });

  it("re-projects over the chosen horizon", async () => {
    await render(SPCX, { kind: "open", onOpen: vi.fn() });
    await act(async () => button("90D").click());
    // Same costs over 90 days: +57.81.
    expect(node.querySelector('[aria-label="Difference"]')!.textContent).toContain("+$57.81");
    expect(text()).toContain("$1,000 for 90 days");
    // The Plan page is off for now, so the dialog no longer links to it.
    expect([...node.querySelectorAll("a")].some((link) => link.textContent?.includes("Full plan"))).toBe(false);
  });

  it("lays the numbers out like a vault page: assumptions, returns by horizon, quick amounts", async () => {
    await render(SPCX, { kind: "open", onOpen: vi.fn() });
    const rows = node.querySelector("[data-testid=share-calc-assumptions]")!.textContent!;
    expect(rows).toContain("Protocol cut of fees16%");
    expect(rows).toContain("Opening cost−$10.00");
    expect(rows).toMatch(/Closing cost \(to USDC\)−\$\d{2}\.\d{2}/);
    expect(rows).toMatch(/Fees collected\$\d{3}\.\d{2}/);
    // One difference vs HODL per horizon of the range switch.
    const horizons = node.querySelector('[aria-label="Difference vs HODL by horizon"]')!;
    expect([...horizons.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["30D", "90D", "180D", "1Y"]);
    expect(node.querySelector('svg[role="img"]')!.getAttribute("aria-label")).toMatch(/^Projected value over 365 days, from \$1,000\.00 to \$1,335\.14$/);
    await act(async () => button("$10K").click());
    expect(node.querySelector<HTMLInputElement>('input[aria-label="Amount in USDC"]')!.value).toBe("10000");
    expect(node.querySelector('[aria-label="Difference"]')!.textContent).toContain("+$3,351.36");
  });

  it("greys the open button with its reason when the pool cannot be opened", async () => {
    await render(SPCX, { kind: "disabled", reason: "Opening is not available yet" });
    const cta = node.querySelector<HTMLButtonElement>("button[aria-label^='Open position in SPCXx/SPCX']")!;
    expect(cta.disabled).toBe(true);
    expect(text()).toContain("Opening is not available yet");
  });

  it("asks for an amount instead of plotting one that does not parse", async () => {
    await render(SPCX, { kind: "open", onOpen: vi.fn() });
    const input = node.querySelector<HTMLInputElement>('input[aria-label="Amount in USDC"]')!;
    const assign = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { assign.call(input, "abc"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("Enter an amount in USDC to see the projection.");
    expect(node.querySelector("[data-testid=hodl-vs-pool]")).toBeNull();
  });

  it("closes itself before starting the open flow, and closes on Escape", async () => {
    const onOpen = vi.fn();
    const onClose = await render(SPCX, { kind: "open", onOpen });
    await act(async () => node.querySelector<HTMLButtonElement>("button[aria-label='Open position in SPCXx/SPCX']")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]!).toBeLessThan(onOpen.mock.invocationCallOrder[0]!);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays in USDC for the stablecoin pool", async () => {
    await render(STABLE, { kind: "open", onOpen: vi.fn() });
    expect(node.querySelector('[role="dialog"]')!.getAttribute("aria-label")).toBe("Calculate for USDC/USDT");
    expect(node.querySelector('[aria-label="Chart unit"]')).toBeNull();
    expect(node.querySelector("[data-testid=hodl-vs-pool] h2")!.textContent).toBe("HODL vs. HODL + fees");
  });
});
