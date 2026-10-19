// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionContext, type WalletConnection } from "../wallet-connection";
import { PlanApp } from "./plan-app";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPCX_B = "So11111111111111111111111111111111111111112";

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

const DAY_SECONDS = 86_400;
const FIRST_DAY = 1_791_417_600; // 2026-10-08 00:00 UTC

/** One point per complete UTC day, oldest first. `fetchedAt` is well after the last day. */
function aprPayload(aprPct: number | null | Array<number | null> = 36.5, days = 8) {
  const values = Array.isArray(aprPct) ? aprPct : Array.from({ length: days }, () => aprPct);
  return {
    poolId: POOL,
    points: values.map((value, i) => ({
      time: FIRST_DAY + i * DAY_SECONDS,
      date: new Date((FIRST_DAY + i * DAY_SECONDS) * 1000).toISOString().slice(0, 10),
      aprPct: value,
      volumeUsd: 1_000,
      tvlUsd: 10_000,
    })),
    fetchedAt: "2026-12-31T00:00:00.000Z",
  };
}

function mockApr(payload: ReturnType<typeof aprPayload>) {
  fetcher.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/rwa-pairs")) return { ok: true, json: async () => pairsPayload() };
    return { ok: true, json: async () => payload };
  });
}

function pairsPayload() {
  return {
    pairs: [
      {
        poolAddress: POOL,
        wrappedSymbol: "SPCXx",
        plainSymbol: "SPCX",
        feeTierBps: 1,
        tvlUsd: 1_200_000,
      },
      {
        poolAddress: SPCX_B,
        wrappedSymbol: "SPCXx",
        plainSymbol: "SPCX",
        feeTierBps: 5,
        tvlUsd: 80_000,
      },
      {
        poolAddress: OTHER,
        wrappedSymbol: "MSTRx",
        plainSymbol: "MSTR",
        feeTierBps: 1,
        tvlUsd: 400_000,
      },
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

async function typeInto(pill: RegExp, inputLabel: string, value: string) {
  const button = [...node.querySelectorAll("button")].find((b) => pill.test(b.textContent ?? ""));
  if (!button) throw new Error(`pill missing: ${pill}`);
  await act(async () => button.click());
  const input = node.querySelector<HTMLInputElement>(`input[aria-label="${inputLabel}"]`);
  if (!input) throw new Error(`input missing: ${inputLabel}`);
  const assign = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    assign?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const setAmount = (value: string) => typeInto(/^\s*[\d,.]+ USDC/, "Amount to put in, in USDC", value);
const setDays = (value: string) => typeInto(/^\s*\d+ days?\s*$/, "Days it stays in", value);
const aprFetches = () => fetcher.mock.calls.filter((call) => String(call[0]).includes("/api/pool-daily-apr")).length;

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
  it("opens on \"I'll put in 1,000 USDC for 30 days\" for the default SPCXx/SPCX pool", async () => {
    await render();
    await waitForText("Est. best APY used · not guaranteed");
    expect(text()).toContain("I'll put in 1,000 USDC for 30 days.");
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="Pool"]')?.value).toBe(POOL);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/rwa-pairs"))).toBe(true);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes(`/api/pool-daily-apr?poolId=${POOL}`))).toBe(true);
    const options = [...node.querySelectorAll<HTMLOptionElement>("select[aria-label='Pool'] option")].map((o) => o.textContent);
    expect(options.some((label) => label?.includes("0.01% fee") && label.includes("DUzB"))).toBe(true);
    expect(options.some((label) => label?.includes("0.05% fee") && label.includes("So11"))).toBe(true);
    expect(new Set(options).size).toBe(options.length);
  });

  it("no longer asks for a net-gain aim", async () => {
    await render();
    await waitForText("Est. best APY used · not guaranteed");
    expect(text()).not.toMatch(/I want|to net|net gain you're aiming|your aim|aim \+|Pace to your aim|Aim for/i);
    expect(node.querySelector('[aria-label="Target gain as a share of the amount"]')).toBeNull();
    expect([...node.querySelectorAll("button")].some((b) => /net|take profit|beat holding/i.test(b.textContent ?? ""))).toBe(false);
  });

  it("projects the final value, net gain, % and break-even from the best APY", async () => {
    await render(`pool=${POOL}`);
    await waitForText("Est. best APY used · not guaranteed");
    // 36.5% APR → 0.1%/day; 1,000 × 1.001^30 − 1,000 − 10 (1% open cost) = +20.44.
    expect(text()).toMatch(/Projected final value\s*1,020\.44 USDC/);
    expect(text()).toMatch(/Net gain\s*\+20\.44 USDC · \+2\.04%/);
    expect(text()).toMatch(/Opening cost, day 0\s*−10\.00 USDC \(about 1%\)/);
    expect(text()).toMatch(/Est. best APY used · not guaranteed\s*44% est. APY/);
    expect(text()).toMatch(/Break-even\s*Day 10/);
    expect(text()).toContain("SoFinance vs hold");
    expect(text()).toContain("break-even day 10");
    expect(text()).toContain("Best case, not a probability or a promise");
    expect(text()).toContain("Network fees are ignored");
    expect(text()).not.toMatch(/bps|swap fee/i);
    expect(aprFetches()).toBe(1);
  });

  it("uses the highest of the 7, 30 and 90-day averages and says which one", async () => {
    mockApr(aprPayload([...Array.from({ length: 33 }, () => 10), ...Array.from({ length: 7 }, () => 50)]));
    await render(`pool=${POOL}`);
    await waitForText("Est. best APY used · not guaranteed");
    expect(text()).toContain("7-day average fee APR of 50%");
    expect(text()).toContain("over 7 complete UTC days");
    expect(text()).toMatch(/Windows checked\s*7d 50% · 30d 19\.3% · 90d 17%/);
    expect(text()).toContain("Est. best APY 64.8% (not guaranteed)");
  });

  it("warns instead of headlining a number when the sample is under 7 days", async () => {
    mockApr(aprPayload(141.8, 3));
    await render(`pool=${POOL}`);
    await waitForText("Only 3 complete days of data");
    expect(text()).toContain("this estimate is unreliable");
    expect(text()).toContain("too short to treat as a forecast");
  });

  it("resolves a pair-only link from the cached RWA list", async () => {
    await render("pair=MSTRx%2FMSTR");
    await waitForText("Est. best APY used · not guaranteed");
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="Pool"]')?.value).toBe(OTHER);
    expect(
      fetcher.mock.calls.some((call) => String(call[0]).includes(`/api/pool-daily-apr?poolId=${OTHER}`)),
    ).toBe(true);
  });

  it("explains an unknown pair-only link instead of fabricating a pool", async () => {
    await render("pair=NVDAx%2FNVDA");
    await waitForText("This link names a pair but has no pool id");
    expect(text()).not.toContain("Est. best APY used · not guaranteed");
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/pool-daily-apr"))).toBe(false);
  });

  it("updates the amount from the ruler without refetching", async () => {
    await render(`pool=${POOL}`);
    await waitForText("Est. best APY used · not guaranteed");
    const before = aprFetches();
    const slider = node.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute("aria-label")).toBe("Amount to put in");
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(text()).toContain("I'll put in 750 USDC for 30 days.");
    expect(text()).toMatch(/Projected final value\s*765\.33 USDC/);
    expect(aprFetches()).toBe(before);
  });

  it("lets a click on the far right of the ruler reach the last stop", async () => {
    await render(`pool=${POOL}`);
    await waitForText("Est. best APY used · not guaranteed");
    const slider = node.querySelector<HTMLElement>('[role="slider"]')!;
    const wrapper = slider.parentElement!;
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 200, right: 200, top: 0, bottom: 24, height: 24, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => {
      wrapper.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, bubbles: true }));
    });
    expect(text()).toContain("I'll put in 100,000 USDC");
  });

  it("takes any number of days and re-projects over that horizon", async () => {
    await render(`pool=${POOL}`);
    await waitForText("Est. best APY used · not guaranteed");
    await setDays("45");
    expect(text()).toContain("for 45 days.");
    expect(text()).toContain("Projected value after 45 days");
    // 1,000 × 1.001^45 − 1,000 − 10 = +36.0
    expect(text()).toMatch(/Net gain\s*\+3\d\.\d\d USDC/);
    expect(node.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toContain("after 45 days");
    await setDays("1");
    expect(text()).toContain("for 1 day.");
    expect(text()).not.toContain("1 days");
    expect(text()).toMatch(/Break-even\s*Not within this period/);
  });

  it("keeps the loss alert and exit asset as optional secondary controls", async () => {
    await render(`pool=${POOL}`);
    await waitForText("Est. best APY used · not guaranteed");
    expect(text()).toMatch(/Optional\s*Warn me if I'm down 50 USDC, and exit to USDC\./);
    expect(text()).toMatch(/Warn me if down\s*−50 USDC \(5%\)/);
    const exitPill = [...node.querySelectorAll("button")].find((b) => b.textContent?.trim() === "USDC");
    await act(async () => exitPill!.click());
    await click("Keep the tokens");
    expect(text()).toMatch(/Exit to\s*The tokens, price exposure stays/);
  });

  it("rescales the loss alert when the amount goes 1 → 10,000", async () => {
    await render(`pool=${POOL}`);
    await waitForText("Est. best APY used · not guaranteed");
    expect(text()).toContain("50 USDC");
    await setAmount("1");
    expect(text()).toContain("0.05 USDC");
    await setAmount("10000");
    expect(text()).toContain("500 USDC");
    expect(text()).not.toMatch(/Warn me if I'm down 1 USDC/);
  });

  it("opens with a plan carried in the link", async () => {
    await render(`pool=${POOL}&amount=5000&days=90&alert=250&exit=tokens&edit=days`);
    await waitForText("Est. best APY used · not guaranteed");
    expect(text()).toContain("I'll put in 5,000 USDC for 90 days.");
    expect(text()).toContain("250 USDC");
    expect(node.querySelector('input[aria-label="Days it stays in"]')).not.toBeNull();
    expect(text()).toMatch(/Exit to\s*The tokens/);
  });

  it("still opens from old goal-first links without crashing", async () => {
    await render(`pool=${POOL}&amount=5000&days=90&goal=beat-holding&target=500&aim=500&edit=target`);
    await waitForText("Est. best APY used · not guaranteed");
    expect(text()).toContain("I'll put in 5,000 USDC for 90 days.");
    expect(text()).not.toMatch(/beat holding|your aim|aim \+/i);
    expect(node.querySelector('input[aria-label="Amount to put in, in USDC"]')).not.toBeNull();
  });

  it("stays unavailable when the series has no complete days", async () => {
    mockApr(aprPayload(null));
    await render(`pool=${POOL}`);
    await waitForText("No complete UTC days");
    expect(text()).not.toContain("Est. best APY used · not guaranteed");
    expect(text()).toContain("No average yield for this pool.");
  });
});
