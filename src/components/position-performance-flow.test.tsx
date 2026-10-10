// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionPerformancePanel } from "./position-performance-panel";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import fixture from "./__fixtures__/position-performance-sample.json";

vi.mock("./pool-activity-panel", () => ({ PoolActivityPanel: () => null }));
vi.mock("./pool-daily-apr-panel", () => ({ PoolDailyAprChart: () => null }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));

const firstMint = fixture.positionMint;
const secondMint = "33333333333333333333333333333333";
const walletA = "11111111111111111111111111111111";
const walletB = "22222222222222222222222222222222";
const position = (positionMint: string) => ({ positionMint, mintA: fixture.mintA, mintB: fixture.mintB });
let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let positions: ReturnType<typeof position>[];
let response: typeof fixture;

function render(wallet = walletA, initialMint = "", sharedMint?: string) {
  const connection: WalletConnection = {
    address: wallet, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false,
    walletsCount: 1, connectionError: "", signTransaction: async (tx) => tx,
  };
  root.render(createElement(WalletConnectionContext.Provider, { value: connection },
    createElement(PositionPerformancePanel, { initialMint, embedded: sharedMint !== undefined, selectedMint: sharedMint })));
}
async function scan(wallet = walletA, initialMint = "") {
  await act(async () => { render(wallet, initialMint); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
async function compute() {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes("Compute performance"));
  expect(button?.disabled).toBe(false);
  await act(async () => { button!.click(); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  positions = [position(firstMint), position(secondMint)];
  response = structuredClone(fixture);
  fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith("/api/wallet?") ? { positions } : response }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("position performance workflow", () => {
  it("selects the first wallet position, keeps an explicit choice and computes that selection", async () => {
    await scan();
    const select = container.querySelector<HTMLSelectElement>("#perf-position")!;
    expect(select.value).toBe(firstMint);
    expect(container.textContent).toContain("Step 1 · Select a position");
    expect(container.textContent).toContain("Step 2 · Compute performance");
    await act(async () => { select.value = secondMint; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(select.value).toBe(secondMint);
    response.positionMint = secondMint;
    await compute();
    expect(fetchMock.mock.calls.some(([url]) => url.includes(`/api/position-performance?positionMint=${secondMint}`))).toBe(true);
    expect(container.textContent).toContain("Performance results");
  });

  it("preserves a URL mint and resets wallet-bound choices when the wallet changes", async () => {
    await scan(walletA, secondMint);
    expect(container.querySelector<HTMLSelectElement>("#perf-position")!.value).toBe(secondMint);
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>("#perf-position")!;
      select.value = firstMint;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    positions = [position(secondMint)];
    await scan(walletB);
    expect(container.querySelector<HTMLSelectElement>("#perf-position")!.value).toBe(secondMint);
  });

  it("offers RWA Pairs only after a successful scan with no positions", async () => {
    positions = [];
    await scan();
    expect(container.querySelector('a[href="/app/rwa-pairs"]')?.textContent).toContain("Explore RWA Pairs");
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes("Compute performance"));
    expect(button?.disabled).toBe(true);
  });

  it("does not treat a wallet scan error as an empty wallet", async () => {
    fetchMock.mockRejectedValue(new Error("RPC unavailable"));
    await scan();
    expect(container.querySelector('a[href="/app/rwa-pairs"]')).toBeNull();
    expect(container.textContent).toContain("Could not load positions");
  });

  it("shows hours below 24 hours and explains missing TE returns", async () => {
    response.metrics.holdingDays = 0.5;
    response.tokenNative.tokenEquivalent.metrics.deposited = 0;
    response.metrics.depositedRaw = { a: "0", b: "0" };
    response.tokenNative.tokenEquivalent.metrics.holdingPeriodReturnPct = null as unknown as number;
    response.tokenNative.tokenEquivalent.metrics.annualizedReturnPct = null as unknown as number;
    response.tokenNative.tokenEquivalent.metrics.feeOnlyAprPct = null as unknown as number;
    await scan();
    await compute();
    expect(container.textContent).toContain("Holding hours");
    expect(container.textContent).toContain("12.00 hr");
    expect(container.textContent).toContain("No positive deposit amount");
    expect(container.textContent).toContain("No deposit history was found");
    expect(container.textContent).not.toContain(`${response.tokenNative.tokenEquivalent.metrics.pnl.toPrecision(6)} ${response.tokenNative.tokenEquivalent.baseSymbol}`);
    expect(container.textContent).toContain("Amounts shown in");
    expect(container.textContent).toContain("Position asset details");
    const tickText = Array.from(container.querySelectorAll("div")).find((node) => node.childElementCount === 0 && node.textContent?.includes("Tick "));
    expect(tickText?.closest("details")?.open).toBe(false);
    expect(container.textContent).toContain("Removed / collected");
  });

  it("shows days at 24 hours and displays known zero returns as zero", async () => {
    response.metrics.holdingDays = 1;
    response.tokenNative.tokenEquivalent.metrics.holdingPeriodReturnPct = 0;
    response.tokenNative.tokenEquivalent.metrics.annualizedReturnPct = 0;
    response.tokenNative.tokenEquivalent.metrics.feeOnlyAprPct = 0;
    await scan();
    await compute();
    expect(container.textContent).toContain("Holding days");
    expect(container.textContent).toContain("1.00 days");
    expect(container.textContent).toContain("0.00%");
    expect(container.textContent).not.toContain("No positive deposit amount");
  });
  it("uses the shared position in embedded mode without rescanning the wallet", async () => {
    await act(async () => { render(walletA, "", firstMint); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("#perf-position")).toBeNull();
    await compute();
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`positionMint=${firstMint}`);
    expect(container.querySelector('[aria-label="Performance results"]')).not.toBeNull();
    await act(async () => { render(walletA, "", secondMint); });
    expect(container.querySelector('[aria-label="Performance results"]')).toBeNull();
    response.positionMint = secondMint;
    await compute();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain(`positionMint=${secondMint}`);
  });

});
