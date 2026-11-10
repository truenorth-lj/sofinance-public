// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { dexDescriptors, SOL_NEED_UNKNOWN_COPY, OPEN_RANGES_UNAVAILABLE, DEPOSIT_MINIMUM_UNAVAILABLE } from "@/lib/dex/client";
import type { OpenRanges } from "@/lib/dex/client";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import type { UnifiedPool } from "@/lib/unified-pools/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const WALLET = "EweT1111111111111111111111111111111111111111";
const mocks = vi.hoisted(() => ({ runSteps: vi.fn(async () => null), tx: {} as Record<string, unknown>, connected: true }));
vi.mock("../wallet-connection", () => ({ useWalletConnection: () => ({ address: mocks.connected ? WALLET : undefined, connected: mocks.connected, connect: vi.fn(), signTransaction: vi.fn(), signAndSendTransaction: vi.fn() }) }));
vi.mock("../transactions/use-tx-pipeline", () => ({ useTxPipeline: () => ({ status: "idle", locked: false, closeLocked: false, runSteps: mocks.runSteps, retry: vi.fn(), interrupted: null, dismissInterrupted: vi.fn(), ...mocks.tx }) }));

import { APR_UNAVAILABLE, NO_RANGE_FITS_COPY, openInputs, preferredOpenPresetId, presetOptions, RegistryOpenModal, NETWORK_FEE_COPY, SOL_REFUSED_COPY } from "./registry-open-modal";

const descriptor = dexDescriptors.descriptorFor("meteora-dlmm")!;
const pool = { key: "solana:met1", poolAddress: "met1", chain: "solana", protocol: "meteora-dlmm", pairLabel: "TSLAx/TSLA", symbolA: "TSLAx", symbolB: "TSLA",
  mintA: "mintA", mintB: "mintB" } as unknown as UnifiedPool;
// The server's ranges (bin ids, inclusive) and an APR payload over the same bounds (bin step 10: ticks = bin id × 10, upper exclusive).
const ranges: OpenRanges = { poolId: "met1", decimals: { mintA: 8, mintB: 8 }, presets: [
  { id: "micro", lowerUnit: -2, upperUnit: 1, units: 4, priceLower: 0.99, priceUpper: 1.01 },
  { id: "standard", lowerUnit: -30, upperUnit: 29, units: 60, priceLower: 0.9, priceUpper: 1.1 },
  { id: "wide", lowerUnit: -100, upperUnit: 99, units: 200, priceLower: 0.5, priceUpper: 1.5 },
] };
const apr = { pool: { tickSpacing: 10 }, sample: { degraded: false }, presets: [
  { id: "micro", tickLower: -20, tickUpper: 20, estimate: { status: "unavailable", reason: "no-volume" } },
  { id: "standard", tickLower: -300, tickUpper: 300, estimate: { status: "ok", aprPct: 12.34, inRangeVolumePct: 80, feesPerDayUsd: 1 } },
] } as unknown as PoolRangeAprPayload;

describe("presetOptions / openInputs", () => {
  it("offers presets up to the descriptor's per-position cap; wider ones say not available to open yet", () => {
    const options = presetOptions(ranges.presets, descriptor, apr);
    expect(options.map((item) => [item.id, item.units, item.available])).toEqual([["micro", 4, true], ["standard", 60, true], ["wide", 200, false]]);
    expect(options[2]!.reason).toBe("Not available to open yet: this range spans 200 bins, and one position holds at most 70.");
    expect(options.map((item) => item.apr)).toEqual([APR_UNAVAILABLE, "Est. APR ~12%", APR_UNAVAILABLE]);
  });
  it("APR reads exactly \"APR unavailable\" when the feed failed or is degraded; never 0% or a guess", () => {
    for (const feed of [null, new Error("Pool volume unavailable"), { ...apr, sample: { degraded: true } } as unknown as PoolRangeAprPayload]) {
      expect(presetOptions(ranges.presets, descriptor, feed).map((item) => item.apr)).toEqual([APR_UNAVAILABLE, APR_UNAVAILABLE, APR_UNAVAILABLE]);
    }
  });
  it("uses the same preset id when live bounds have drifted from the snapshot (price moved)", () => {
    // tickSpacing 1 makes the exact-bound join fail (snapshot was priced on spacing 10); "standard" still has an ok estimate.
    const drifted = { ...apr, pool: { tickSpacing: 1 } } as unknown as PoolRangeAprPayload;
    expect(presetOptions(ranges.presets, descriptor, drifted).map((item) => item.apr)).toEqual([APR_UNAVAILABLE, "Est. APR ~12%", APR_UNAVAILABLE]);
  });
  it("never offers native SOL as an input", () => {
    const tokens = openInputs({ ...pool, mintB: NATIVE_SOL_MINT, symbolB: "SOL" }, descriptor, { a: 8, b: 9 });
    expect(tokens.map((item) => item.id)).toEqual(["mintA", USDC_MINT]);
  });
});

const allRanges = [
  { id: "micro" as const, lowerUnit: -2, upperUnit: 1, units: 4, priceLower: 0.99, priceUpper: 1.01 },
  { id: "tight" as const, lowerUnit: -6, upperUnit: 5, units: 12, priceLower: 0.97, priceUpper: 1.03 },
  { id: "standard" as const, lowerUnit: -30, upperUnit: 29, units: 60, priceLower: 0.9, priceUpper: 1.1 },
  { id: "wide" as const, lowerUnit: -100, upperUnit: 99, units: 200, priceLower: 0.5, priceUpper: 1.5 },
];
const RANKED_TICKS = { micro: [-20, 20], tight: [-60, 60], standard: [-300, 300], wide: [-1000, 1000] } as const;
const rankedApr = (aprs: { micro: number | null; tight: number | null; standard: number | null; wide: number | null }): PoolRangeAprPayload =>
  ({ pool: { tickSpacing: 10 }, sample: { degraded: false }, presets: (["micro", "tight", "standard", "wide"] as const).map((id) => ({
    id, tickLower: RANKED_TICKS[id][0], tickUpper: RANKED_TICKS[id][1],
    estimate: aprs[id] === null ? { status: "unavailable", reason: "no-volume" } : { status: "ok", aprPct: aprs[id], inRangeVolumePct: 50, feesPerDayUsd: 1 },
  })) }) as unknown as PoolRangeAprPayload;

describe("preferredOpenPresetId", () => {
  const options = presetOptions(allRanges, descriptor);
  it("selects Best when that range is available to open", () => {
    expect(preferredOpenPresetId(options, rankedApr({ micro: 41, tight: 44, standard: 17, wide: 5 }))).toBe("tight");
  });
  it("falls back to the first available preset when Best is over the cap or there is no APR", () => {
    expect(preferredOpenPresetId(options, null)).toBe("micro");
    expect(preferredOpenPresetId(options, new Error("Pool volume unavailable"))).toBe("micro");
    expect(preferredOpenPresetId(options, rankedApr({ micro: null, tight: null, standard: null, wide: 99 }))).toBe("micro");
  });
});

let solLamports = "1000000000";
let root: Root; let container: HTMLDivElement; let quoteBody: Record<string, unknown>; let calls: { url: string; body: unknown }[];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.tx = {}; mocks.runSteps.mockClear(); mocks.connected = true; calls = []; solLamports = "1000000000";
  quoteBody = { poolId: "met1", range: { lowerPrice: 0.9, upperPrice: 1.1, units: 60 }, steps: 2, platformFeeRaw: "1000",
    rent: { refundableLamports: "41899840", nonRefundableLamports: "0", tokenAccountLamports: "2039280" },
    sol: { networkFeeLamports: "15000", swapAccountsLamports: "4245880", reserveLamports: "10000000" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/wallet")) return Response.json({ assets: [{ kind: "native", mint: NATIVE_SOL_MINT, balance: solLamports }, { kind: "token", mint: USDC_MINT, balance: "5000000" }] });
    return Response.json(quoteBody);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = async (props: Partial<Parameters<typeof RegistryOpenModal>[0]> = {}) =>
  act(async () => root.render(createElement(RegistryOpenModal, { pool, descriptor, ranges, apr, onClose: vi.fn(), ...props })));
const type = async (value: string) => {
  const input = container.querySelector<HTMLInputElement>("#registry-open-amount")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
};
const openButton = () => container.querySelector<HTMLButtonElement>("[data-testid=registry-open-submit]")!;

describe("RegistryOpenModal", () => {
  it("quotes the default preset through the registry route and shows rent, the 0.1% fee, the wallet fee and SOL reserve notes", async () => {
    await render();
    expect(container.querySelector<HTMLButtonElement>("[data-testid=preset-wide]")!.disabled).toBe(true);
    expect(container.textContent).toContain("Not available to open yet");
    expect(container.textContent).not.toContain(NO_RANGE_FITS_COPY);
    const select = container.querySelector<HTMLSelectElement>("#registry-open-token")!;
    await act(async () => { select.value = USDC_MINT; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await type("1");
    const quote = calls.find((call) => call.url === "/api/dex/meteora-dlmm/quote-open")!;
    expect(quote.body).toEqual({ request: { poolId: "met1", range: { kind: "preset", presetId: "standard" }, input: { token: USDC_MINT, amountRaw: "1000000" }, slippageBps: 50, owner: WALLET } });
    const costs = container.querySelector("[data-testid=registry-open-costs]")!.textContent!;
    expect(costs).toContain("Position rent: about 0.0419 SOL, refunded when you close the position.");
    expect(costs).toContain("New token-account rent: about 0.0020 SOL");
    expect(costs).toContain("A 0.1% platform fee applies only to the part we swap into the pool tokens");
    expect(costs).toContain("About 0.001 USDC on this open.");
    expect(costs).toContain(NETWORK_FEE_COPY);
    expect(costs).toContain("Your wallet may add a priority fee to each step (often about 0.001–0.002 SOL)");
    expect(costs).not.toContain("Phantom");
    expect(openButton().disabled).toBe(false);
    await act(async () => { openButton().click(); });
    expect(mocks.runSteps).toHaveBeenCalledTimes(1);
    const [first] = mocks.runSteps.mock.calls[0] as unknown as [{ request: unknown; context: unknown }];
    expect(first.request).toEqual({ poolId: "met1", range: { kind: "preset", presetId: "standard" }, input: { token: USDC_MINT, amountRaw: "1000000" }, slippageBps: 50 });
    expect(first.context).toEqual({ step: 1, priorSignatures: [] });
  });

  const pressedIds = () => [...container.querySelectorAll("[aria-label='Price range presets'] button[aria-pressed='true']")]
    .map((button) => button.getAttribute("data-testid"));

  it("opens with Best selected when that range is available, and the headline matches it", async () => {
    await render({
      ranges: { ...ranges, presets: allRanges },
      apr: rankedApr({ micro: 41, tight: 44, standard: 17, wide: 5 }),
    });
    expect(pressedIds()).toEqual(["preset-best"]);
    expect(container.querySelector("[data-testid=best-resolved]")!.textContent).toBe("Tight");
    expect(container.querySelector("[data-testid=range-apr-headline]")!.textContent).toBe("~44%");
    expect(container.querySelector("[data-testid=preset-standard]")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("falls back to the first available preset when Best is disabled or there is no APR", async () => {
    for (const props of [
      { apr: new Error("Pool volume unavailable") as Error },
      { apr: rankedApr({ micro: null, tight: null, standard: null, wide: 99 }) },
    ]) {
      await render(props);
      expect(pressedIds()).toEqual(["preset-micro"]);
      expect(container.querySelector("[data-testid=preset-best]")).toBeNull();
    }
  });

  it("when every preset exceeds the per-position cap, says no range of this pool fits one position", async () => {
    await render({
      ranges: {
        ...ranges,
        presets: [
          { id: "micro", lowerUnit: -80, upperUnit: 79, units: 160, priceLower: 0.8, priceUpper: 1.2 },
          { id: "tight", lowerUnit: -90, upperUnit: 89, units: 180, priceLower: 0.7, priceUpper: 1.3 },
          { id: "standard", lowerUnit: -100, upperUnit: 99, units: 200, priceLower: 0.6, priceUpper: 1.4 },
          { id: "wide", lowerUnit: -150, upperUnit: 149, units: 300, priceLower: 0.4, priceUpper: 1.6 },
        ],
      },
    });
    expect(container.textContent).toContain(NO_RANGE_FITS_COPY);
    expect([...container.querySelectorAll("[role=alert]")].some((node) => node.textContent === NO_RANGE_FITS_COPY)).toBe(true);
    expect(openButton().disabled).toBe(true);
  });

  it("APR feed down with the server's ranges present: every APR reads \"APR unavailable\" and the position can still be opened", async () => {
    await render({ apr: new Error("Pool volume unavailable") });
    expect(container.querySelector("[data-testid=range-apr-headline]")!.textContent).toMatch(/—|Estimating|unavailable/i);
    expect(container.textContent).toContain("Estimate unavailable right now.");
    expect(container.textContent).not.toMatch(/\b0(\.0)?%/);
    const select = container.querySelector<HTMLSelectElement>("#registry-open-token")!;
    await act(async () => { select.value = USDC_MINT; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await type("1");
    expect(openButton().disabled).toBe(false);
    await act(async () => { openButton().click(); });
    expect(mocks.runSteps).toHaveBeenCalledTimes(1);
  });

  it("ranges the server could not load (5xx): plain words only, no error code, Open disabled", async () => {
    await render({ ranges: new Error(OPEN_RANGES_UNAVAILABLE) });
    const text = container.querySelector("[data-testid=registry-open-ranges-error]")!.textContent;
    expect(text).toBe("We couldn't load this pool right now. Try again in a few minutes.");
    expect(text).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    expect(openButton().disabled).toBe(true);
  });

  it("ranges the server can't work out: Open is disabled and the plain reason shows", async () => {
    await render({ ranges: new Error("This Meteora pool account was not found on chain.") });
    expect(container.querySelector("[data-testid=registry-open-ranges-error]")!.textContent)
      .toBe("This pool's price ranges could not be worked out, so it can't be opened right now: This Meteora pool account was not found on chain.");
    expect(openButton().disabled).toBe(true);
  });

  it("near-miss SOL (0.0566 SOL vs about 0.0582 needed) says how much is missing before any open call, with the server's parts", async () => {
    solLamports = "56600000"; // EweT's balance
    await render();
    const select = container.querySelector<HTMLSelectElement>("#registry-open-token")!;
    await act(async () => { select.value = USDC_MINT; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await type("1");
    expect(container.querySelector("[data-testid=registry-open-sol-short]")!.textContent).toBe(
      "Not enough SOL: this open needs about 0.0582 SOL (rent, network fees, temporary swap accounts and a small reserve), and your wallet has 0.0566 SOL. Add about 0.0016 SOL to open.");
    expect(openButton().disabled).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/open"))).toBe(false);
  });

  it("a quote without SOL parts blocks Open with the plain reason instead of counting the rent only", async () => {
    delete quoteBody.sol;
    await render();
    const select = container.querySelector<HTMLSelectElement>("#registry-open-token")!;
    await act(async () => { select.value = USDC_MINT; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await type("1");
    expect(container.querySelector("[data-testid=registry-open-sol-unknown]")!.textContent).toBe(SOL_NEED_UNKNOWN_COPY);
    expect(container.querySelector("[data-testid=registry-open-sol-short]")).toBeNull();
    expect(openButton().disabled).toBe(true);
    await act(async () => { openButton().click(); });
    expect(mocks.runSteps).not.toHaveBeenCalled();
  });

  it("a quote that needs a new shared account is blocked with its reason and no Open", async () => {
    quoteBody = { ...quoteBody, blockedReason: "This range needs a shared Meteora account (a bin array) that doesn't exist yet." };
    await render();
    await type("1");
    expect(container.querySelector("[data-testid=registry-open-blocked]")!.textContent).toContain("bin array");
    expect(openButton().disabled).toBe(true);
  });

  it("an amount that would round to 0 in the range's steps greys Open and says the minimum (same rule as Add)", async () => {
    quoteBody = { ...quoteBody, depositMinimum: { token: USDC_MINT, tooSmall: true, minimumRaw: "48336" } };
    await render();
    const select = container.querySelector<HTMLSelectElement>("#registry-open-token")!;
    await act(async () => { select.value = USDC_MINT; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await type("0.015");
    expect(container.querySelector("[data-testid=registry-open-too-small]")!.textContent)
      .toBe("This amount is too small to add to every price step in this range. Try at least 0.0484 USDC.");
    expect(openButton().disabled).toBe(true);
    await act(async () => { openButton().click(); });
    expect(mocks.runSteps).not.toHaveBeenCalled();
    // A big enough amount (the quote says so) opens normally.
    quoteBody = { ...quoteBody, depositMinimum: { token: USDC_MINT, tooSmall: false, minimumRaw: null } };
    await type("0.06");
    expect(container.querySelector("[data-testid=registry-open-too-small]")).toBeNull();
    expect(openButton().disabled).toBe(false);
  });

  it("the minimum could not be checked (unavailable): Open stays disabled with a plain try-again line", async () => {
    quoteBody = { ...quoteBody, depositMinimum: { token: USDC_MINT, tooSmall: true, minimumRaw: null, quoteChecked: false, unavailable: true } };
    await render();
    const select = container.querySelector<HTMLSelectElement>("#registry-open-token")!;
    await act(async () => { select.value = USDC_MINT; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await type("1");
    expect(container.querySelector("[data-testid=registry-open-too-small]")!.textContent).toBe(DEPOSIT_MINIMUM_UNAVAILABLE);
    expect(openButton().disabled).toBe(true);
  });

  it("a refused quote shows the server's plain reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/wallet") ? Response.json({ assets: [] })
      : Response.json({ error: "This range spans 200 bins, but one Meteora position holds at most 70, so it's not available to open yet." }, { status: 400 })));
    await render();
    await type("1");
    expect(container.textContent).toContain("so it's not available to open yet");
    expect(openButton().disabled).toBe(true);
  });

  it("says why SOL is not offered when it is a pool token", async () => {
    await render({ pool: { ...pool, mintB: NATIVE_SOL_MINT, symbolB: "SOL" } as UnifiedPool, ranges: { ...ranges, decimals: { mintA: 8, [NATIVE_SOL_MINT]: 9 } } });
    expect(container.querySelector("[data-testid=registry-open-sol]")!.textContent).toBe(SOL_REFUSED_COPY);
    expect([...container.querySelectorAll("#registry-open-token option")].map((o) => o.textContent?.split(" · ")[0])).toEqual(["TSLAx", "USDC"]);
  });

  it("shows the full form without a wallet, with Connect wallet instead of hiding the fields", async () => {
    mocks.connected = false;
    await render();
    expect(container.querySelector("#registry-open-token")).not.toBeNull();
    expect(container.querySelector("#registry-open-amount")).not.toBeNull();
    expect(container.querySelector("[data-testid=preset-best], [data-testid=range-apr-headline]")).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Connect wallet")).toBe(true);
    expect(container.querySelector("[data-testid=registry-open-submit]")).toBeNull();
    expect(container.textContent).not.toContain("Connect your wallet to open a position");
  });

  it("success says opened with a Solscan link; the close button is locked while the wallet is open", async () => {
    mocks.tx = { status: "success", signature: "5".repeat(88) };
    await render();
    expect(container.textContent).toContain("Position opened.");
    expect(container.querySelector("a[href*='solscan.io/tx/']")).not.toBeNull();
    mocks.tx = { status: "wallet", locked: true, closeLocked: true };
    await render();
    expect(container.querySelector<HTMLButtonElement>("button[aria-label=Close]")!.disabled).toBe(true);
  });
});
