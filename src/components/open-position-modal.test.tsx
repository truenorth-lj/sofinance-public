// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Single-transaction suites use wSOL token input (native SOL opens in two steps); the
// flag mock keeps native SOL listed for the quote/preview and switch tests.
const solInputFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/feature-flags")>(),
  get SOL_INPUT_ENABLED() { return solInputFlag.enabled; },
}));
import { NATIVE_SOL_MINT, QUOTE_TTL_MS } from "@sofinance/engine/ids";
import type { OpenPositionQuote } from "@sofinance/engine/open-types";
import { payloadFixture, payloadWithAprs } from "../lib/range-apr/payload.fixture";
import { clearPoolRangeAprClientCache } from "./range-apr/pool-range-apr-client";
import { OpenPositionModal } from "./open-position-modal";
import type { OpenPositionPair, useOpenPositionController } from "./use-open-position-controller";
import { QUOTE_ERROR_POLL_PAUSE_MS, RELAY_QUOTE_POLL_MS } from "./use-open-position-controller";

// Browsers quote Jupiter themselves (keyless, per-IP quota), so the modal polls every RELAY_QUOTE_POLL_MS.
const POLL = RELAY_QUOTE_POLL_MS;

const mocks = vi.hoisted(() => ({
  wallet: "wallet",
  controller: null as ReturnType<typeof useOpenPositionController> | null,
}));

vi.mock("./wallet-connection", () => ({
  useWalletConnection: () => ({ address: mocks.wallet, connected: true, connect: vi.fn(), signTransaction: vi.fn() }),
}));

vi.mock("./use-open-position-controller", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-open-position-controller")>();
  return { ...original, useOpenPositionController: (pair: OpenPositionPair) => {
    mocks.controller = original.useOpenPositionController(pair);
    return mocks.controller;
  } };
});

const pair: OpenPositionPair = {
  poolAddress: "pool", mintA: "mint-a", mintB: "mint-b", symbolA: "HOODx", symbolB: "HOOD",
  wrappedSymbol: "HOODx", plainSymbol: "HOOD", feeTierBps: 1,
  token2022A: true, token2022B: false, freezeRisk: true,
};

function quote(): OpenPositionQuote {
  return {
    wallet: mocks.wallet, poolId: pair.poolAddress, inputMint: NATIVE_SOL_MINT, inputKind: "token",
    inputDecimals: 9, mintA: pair.mintA, mintB: pair.mintB, decimalsA: 6, decimalsB: 6,
    symbolA: "HOODx", symbolB: "HOOD", feeTierBps: 1, tickSpacing: 1, tickCurrent: 0,
    priceLower: 0.9974, priceUpper: 1.0094, currentPrice: "1", projectedPrice: "1",
    rangePreset: "standard", inRange: true, narrowRange: false, rangeWarning: null,
    minOutA: "64636", minOutB: "56124", requested: "120000000",
    spendA: "60000000", spendB: "60000000", liquidity: "1000",
    amountMaxA: "64636", amountMaxB: "56124", requiredA: "64000", requiredB: "55000",
    toleranceBps: 100, dustA: "636", dustB: "1124",
    resaleInput: "119000000", minimumResaleInput: "118800000", roundtripCostInput: "1000000",
    passesFloor: true, floorBps: 9900, suggestedResaleFloorBps: 9910, maxAmountForFloor: "120000000",
    achievedResaleBps: 9916, warning: "",
    slippageBps: 50,
    routeTouchesTargetPool: false, token2022A: true, token2022B: false,
    freezeRiskA: true, freezeRiskB: false, freezeRisk: true,
    transferFee: false, paused: false, frozen: false, unsupportedExtensions: [],
    maxImpactBps: 500, tickLower: -26, tickUpper: 94,
    rangeSide: "inside", warnings: [], solLamports: "226500000", networkFeeLamportsEstimate: "50000",
    rent: {
      refundableLamports: "7800000", nonRefundableLamports: "1800000",
      positionNftLamports: "2000000", nftAtaLamports: "2000000", personalPositionLamports: "3800000",
      tickArrayLamports: "0", protocolPositionLamports: "1800000",
      tickArrayInitRequired: false, protocolPositionInitRequired: true, tickArrayAccounts: [],
    },
    requiredSolLamports: "139650000", sufficientSol: true, sufficientInput: true,
    feeBps: 0, feeAmount: "0", feeWallet: null, slot: 1,
    fetchedAt: Date.now(), expiresAt: Date.now() + QUOTE_TTL_MS,
  };
}

let root: Root;
let container: HTMLDivElement;
let failQuote: boolean;
let quoteCalls: number;
let deferredQuote: Promise<unknown> | null;
let quoteBodies: Array<Record<string, unknown>>;

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function mount() {
  await act(async () => { root.render(createElement(OpenPositionModal, { pair, onClose: vi.fn() })); });
  await advance(1);
  await act(async () => { mocks.controller!.changeAmount("0.12"); });
  await advance(450);
}

function signButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Create position")!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.wallet = "wallet";
  mocks.controller = null;
  failQuote = false;
  quoteCalls = 0;
  deferredQuote = null;
  quoteBodies = [];
  clearPoolRangeAprClientCache();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/pool-range-apr")) return { ok: true, json: async () => payloadFixture() };
    if (url === "/api/sol-usdc-price") return { ok: true, json: async () => ({ rate: 150 }) };
    if (url.startsWith("/api/wallet")) return { ok: true, json: async () => ({ assets: [{
      kind: "token", mint: NATIVE_SOL_MINT, decimals: 9, balance: "216474000", eligible: true,
    }] }) };
    if (url === "/api/open-quote") {
      quoteCalls++;
      if (typeof init?.body === "string") quoteBodies.push(JSON.parse(init.body));
      if (deferredQuote) return deferredQuote;
      return { ok: !failQuote, json: async () => failQuote ? { error: "Quote service unavailable" } : quote() };
    }
    if (url === "/api/open-prepare") return new Promise(() => undefined);
    throw new Error(`Unexpected request: ${url}`);
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("range presets and estimated APR", () => {
  const presetButton = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("[aria-label='Price range presets'] button")]
      .find((button) => button.querySelector("span")?.textContent === label)!;

  // `solPrice: false` leaves the typed SOL amount without a USD value, so ranking uses the payload's own
  // (reference-capital) estimates; that isolates the row/Best layout from the size-aware re-pricing.
  const stubApr = (data: ReturnType<typeof payloadFixture>, { solPrice = false } = {}) => {
    const original = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith("/api/pool-range-apr") ? { ok: true, json: async () => data }
        : url === "/api/sol-usdc-price" && !solPrice ? { ok: false, json: async () => ({ error: "down" }) }
          : original(url, init)));
  };
  const rowLabels = () => [...container.querySelectorAll("[aria-label='Price range presets'] button")].map((b) => b.querySelector("span")?.textContent);

  it("lists Best leftmost, then the remaining candidates narrow to wide, then Custom; Standard stays selected", async () => {
    stubApr(payloadWithAprs({ micro: 10, tight: 38, standard: 20, wide: 5 }));
    await mount();
    expect(rowLabels()).toEqual(["Best", "Micro", "Standard", "Wide", "Custom"]);
    expect(container.querySelector("[data-testid='best-resolved']")!.textContent).toBe("Tight");
    expect(container.querySelector("[data-testid='apr-tight']")!.textContent).toBe("~38%");
    expect(presetButton("Standard").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-testid='preset-best']")!.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-testid='range-apr-headline']")!.textContent).toBe("~20%");
  });

  it("clicking Best requests the resolved candidate's own preset ('tight'), so what is signed is what was priced", async () => {
    stubApr(payloadWithAprs({ micro: 10, tight: 38, standard: 20, wide: 5 }));
    await mount();
    await act(async () => { container.querySelector<HTMLButtonElement>("[data-testid='preset-best']")!.click(); });
    await advance(450);
    expect(container.querySelector("[data-testid='preset-best']")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-testid='range-apr-headline']")!.textContent).toBe("~38%");
    expect(quoteBodies.at(-1)).toMatchObject({ rangePreset: "tight" });
    expect(container.textContent).toContain("Best for this pool is Tight");
    expect(container.querySelector("[data-testid='small-amount-narrow-range-hint']")).toBeNull();
  });

  it("hints to try Standard or Wide when the amount is a few USDC and Tight is selected", async () => {
    await mount();
    expect(container.querySelector("[data-testid='small-amount-narrow-range-hint']")).toBeNull();
    await act(async () => { mocks.controller!.changeAmount("0.02"); });
    await act(async () => { mocks.controller!.choosePreset("tight"); });
    await advance(1);
    expect(container.querySelector("[data-testid='small-amount-narrow-range-hint']")!.textContent)
      .toMatch(/Standard or Wide/);
  });

  it("when Standard is the Best pick, the default selection is Best and Standard is not listed twice", async () => {
    stubApr(payloadWithAprs({ micro: 1, tight: 2, standard: 40, wide: 3 }));
    await mount();
    expect(rowLabels()).toEqual(["Best", "Micro", "Tight", "Wide", "Custom"]);
    expect(container.querySelector("[data-testid='preset-best']")!.getAttribute("aria-pressed")).toBe("true");
    expect(quoteBodies.at(-1)).toMatchObject({ rangePreset: "standard" });
  });

  it("re-ranks Best for the typed amount after a debounce, hiding ranges the deposit does not fit", async () => {
    // Flat fixture pool: 1e9 liquidity per 1-tick bin. At 0.12 SOL (~$18) every range fits and the narrowest
    // (Micro) has the highest estimate; at 1,500 SOL (~$225k) Micro would be over half the active liquidity
    // and the narrower ranges' edges are within 3x the estimated impact, so Best moves to Wide.
    stubApr(payloadFixture(), { solPrice: true });
    await mount();
    await advance(400);
    expect(container.querySelector("[data-testid='best-resolved']")!.textContent).toBe("Micro");
    expect(container.textContent).toContain("For a ~$18 deposit");
    await act(async () => { mocks.controller!.changeAmount("1500"); });
    await advance(100);
    expect(container.querySelector("[data-testid='best-resolved']")!.textContent).toBe("Micro");
    await advance(400);
    expect(container.querySelector("[data-testid='best-resolved']")!.textContent).toBe("Wide");
    // Ranges the deposit does not fit are not offered at all, and the default Standard falls back to Best.
    for (const id of ["micro", "tight"]) {
      expect(container.querySelector(`[data-testid='preset-${id}']`)).toBeNull();
      expect(container.querySelector(`[data-testid='apr-${id}']`)).toBeNull();
    }
    expect(container.textContent).not.toMatch(/doesn't fit|large vs pool liquidity|edge near est\. price impact/);
    expect(mocks.controller!.rangePreset).toBe("wide");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/pool-range-apr"))).toHaveLength(1);
  });

  it("still lets the user create a position when the estimate is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/pool-range-apr")) return { ok: false, json: async () => ({ error: "down" }) };
      if (url === "/api/sol-usdc-price") return { ok: true, json: async () => ({ rate: 150 }) };
      if (url.startsWith("/api/wallet")) return { ok: true, json: async () => ({ assets: [{ kind: "token", mint: NATIVE_SOL_MINT, decimals: 9, balance: "216474000", eligible: true }] }) };
      if (url === "/api/open-quote") return { ok: true, json: async () => quote() };
      throw new Error(`Unexpected request: ${url}`);
    }));
    await mount();
    expect(container.textContent).toContain("Estimate unavailable right now");
    expect(rowLabels()).toEqual(["Micro", "Tight", "Standard", "Wide", "Custom"]);
    expect(container.querySelector("[data-testid='preset-best']")).toBeNull();
    expect(signButton().disabled).toBe(false);
  });
});

describe("open-position signing and quote refresh", () => {
  it("shows USDC equivalents for upfront fees and refundable deposits", async () => {
    await mount();
    expect(container.textContent).toContain("0.00965 SOL (≈ 1.4475 USDC)");
    expect(container.textContent).toContain("0.0078 SOL (≈ 1.17 USDC)");
    expect(container.textContent).toContain("0.00005 SOL (≈ 0.0075 USDC)");
  });
  it("shows the protocol fee in the deposited input token", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/pool-range-apr")) return { ok: true, json: async () => payloadFixture() };
      if (url === "/api/sol-usdc-price") return { ok: true, json: async () => ({ rate: 150 }) };
      if (url.startsWith("/api/wallet")) return { ok: true, json: async () => ({ assets: [{
        kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "216474000", eligible: true,
      }] }) };
      if (url === "/api/open-quote") {
        return { ok: true, json: async () => ({ ...quote(), inputKind: "native", feeBps: 10, feeAmount: "120000", feeWallet: "Fee111111111111111111111111111111111111111" }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    await mount();
    expect(container.textContent).toContain("Protocol fee");
    expect(container.textContent).toContain("0.00012 SOL");
    expect(container.textContent).toContain("The protocol fee is 10 bps of the token you deposit");
  });
  it("enables signing with a fresh quote and explains why Sign is disabled when it is not", async () => {
    await mount();
    expect(signButton().disabled).toBe(false);
    expect(container.textContent).not.toContain("Ready to sign");
    expect(container.textContent).not.toContain("Complete the form to sign");
    await act(async () => { signButton().click(); });
    expect(container.textContent).toContain("Preparing latest transaction");
  });

  it("shows round-trip total cost in the summary and tooltip without disabling Sign", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/wallet")) return { ok: true, json: async () => ({ assets: [{
        kind: "token", mint: NATIVE_SOL_MINT, decimals: 9, balance: "216474000", eligible: true,
      }] }) };
      if (url === "/api/open-quote") {
        quoteCalls++;
        return { ok: true, json: async () => ({
          ...quote(),
          passesFloor: false,
          achievedResaleBps: 9000,
          resaleInput: "108000000",
          roundtripCostInput: "12000000",
          warning: "Conservative immediate resale is 90.00% of input, below the 99.00% floor.",
          warnings: ["Conservative immediate resale is 90.00% of input, below the 99.00% floor."],
        }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    await mount();
    expect(signButton().disabled).toBe(false);
    expect(container.textContent).toContain("Total cost");
    expect(container.textContent).toContain("~10.00%");
    expect(container.textContent).not.toContain("Price impact cap");
    expect(container.textContent).not.toContain("Immediate resale of this position");
    const info = container.querySelector<HTMLButtonElement>('button[aria-label="About Total cost"]')!;
    await act(async () => { info.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Estimated round-trip cost: about 10.00% (assuming you open the position, immediately withdraw, and swap back to WSOL). This conservative estimate includes swap fees, price impact, and slippage tolerance. It does not block signing.");
    expect(container.querySelector('[role="tooltip"]')?.classList.contains("bg-char")).toBe(true);
    await act(async () => {
      info.click();
      info.focus();
      info.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.textContent).not.toContain("Ready to sign");
  });

  it("fetches a new quote every poll interval without waiting for expiry", async () => {
    await mount();
    expect(signButton().disabled).toBe(false);
    await advance(POLL - 1);
    expect(quoteCalls).toBe(1);
    await advance(1);
    expect(quoteCalls).toBe(2);
    expect(signButton().disabled).toBe(false);
    await advance(POLL);
    expect(quoteCalls).toBe(3);
  });

  it("does not poll quotes while the tab is hidden and refreshes once it is visible again", async () => {
    await mount();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await advance(9000);
    expect(quoteCalls).toBe(1);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(quoteCalls).toBe(2);
    hidden.mockRestore();
  });

  it("pauses background polling for a while after a failed refresh", async () => {
    await mount();
    failQuote = true;
    await advance(POLL);
    expect(quoteCalls).toBe(2);
    await advance(Math.max(0, QUOTE_ERROR_POLL_PAUSE_MS - POLL));
    expect(quoteCalls).toBe(2);
    failQuote = false;
    await advance(POLL);
    expect(quoteCalls).toBe(3);
  });

  it("lets the user retry a failed refresh without editing a valid amount", async () => {
    await mount();
    failQuote = true;
    await advance(POLL);
    expect(signButton().disabled).toBe(true);
    expect(container.textContent).toContain("Quote service unavailable");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh quote");
    expect(retry).toBeDefined();
    failQuote = false;
    await act(async () => { retry!.click(); });
    await advance(450);
    expect(quoteCalls).toBe(3);
    expect(signButton().disabled).toBe(false);
  });

  it("cancels the previous expiry timer when the amount changes", async () => {
    await mount();
    await advance(1000);
    await act(async () => { mocks.controller!.changeAmount(""); });
    await advance(QUOTE_TTL_MS);
    expect(quoteCalls).toBe(1);
    expect(signButton().disabled).toBe(true);
  });

  it("does not refresh or re-enable signing while preparing a transaction", async () => {
    await mount();
    await act(async () => { signButton().click(); });
    await advance(QUOTE_TTL_MS + 1000);
    expect(quoteCalls).toBe(1);
    expect(container.textContent).toContain("Preparing latest transaction");
  });

  it("does not restore an old quote when a cancelled request resolves late", async () => {
    let resolveQuote!: (value: unknown) => void;
    deferredQuote = new Promise((resolve) => { resolveQuote = resolve; });
    await mount();
    expect(mocks.controller!.quoteLoading).toBe(true);
    expect(container.textContent).toContain("Fetching the best price on Jupiter");
    await act(async () => { mocks.controller!.changeAmount(""); });
    await act(async () => { resolveQuote({ ok: true, json: async () => quote() }); });
    expect(mocks.controller!.quote).toBeNull();
    expect(mocks.controller!.quoteLoading).toBe(false);
    expect(container.textContent).not.toContain("Fetching the best price on Jupiter");
    expect(signButton().disabled).toBe(true);
    await advance(QUOTE_TTL_MS + 1000);
    expect(quoteCalls).toBe(1);
  });

  it("does not keep requesting quotes after the modal closes", async () => {
    await mount();
    await act(async () => { root.unmount(); });
    await advance(QUOTE_TTL_MS + 1000);
    expect(quoteCalls).toBe(1);
  });

  it("keeps a fresh quote usable during a slow refresh without overlapping requests", async () => {
    await mount();
    let resolveQuote!: (value: unknown) => void;
    deferredQuote = new Promise((resolve) => { resolveQuote = resolve; });
    await advance(POLL);
    expect(quoteCalls).toBe(2);
    expect(mocks.controller!.quoteLoading).toBe(true);
    expect(signButton().disabled).toBe(false);
    await advance(9000);
    expect(quoteCalls).toBe(2);
    await act(async () => { resolveQuote({ ok: true, json: async () => quote() }); });
    expect(signButton().disabled).toBe(false);
    expect(mocks.controller!.quoteLoading).toBe(false);
  });

  it("disables signing if the last quote expires while a refresh is stalled", async () => {
    await mount();
    deferredQuote = new Promise(() => undefined);
    await advance(POLL);
    await advance(QUOTE_TTL_MS + 1000);
    expect(signButton().disabled).toBe(true);
    expect(quoteCalls).toBe(2);
  });

  it("starts preparation during a background refresh and ignores its late response", async () => {
    await mount();
    const previousQuote = mocks.controller!.quote;
    let resolveQuote!: (value: unknown) => void;
    deferredQuote = new Promise((resolve) => { resolveQuote = resolve; });
    await advance(POLL);
    await act(async () => { signButton().click(); });
    expect(mocks.controller!.submitStage).toBe("preparing");
    expect(mocks.controller!.quoteLoading).toBe(false);
    await act(async () => { resolveQuote({ ok: true, json: async () => quote() }); });
    expect(mocks.controller!.quote).toBe(previousQuote);
    expect(mocks.controller!.quoteError).toBe("");
    await advance(9000);
    expect(quoteCalls).toBe(2);
  });
});

describe("temporary SOL input switch (SOL_INPUT_ENABLED = false)", () => {
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const stubWallet = (assets: unknown[]) => {
    const original = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith("/api/wallet") ? { ok: true, json: async () => ({ assets }) } : original(url, init)));
  };
  const solAsset = { kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "216474000", eligible: true, reason: null };
  const usdcAsset = { kind: "token", mint: usdc, decimals: 6, balance: "5000000", eligible: true, reason: null };
  beforeEach(() => { solInputFlag.enabled = false; });
  afterEach(() => { solInputFlag.enabled = true; });

  it("shows SOL as an unselectable option with the note and defaults to another token", async () => {
    stubWallet([solAsset, usdcAsset]);
    await act(async () => { root.render(createElement(OpenPositionModal, { pair, onClose: vi.fn() })); });
    await advance(1);
    const option = container.querySelector<HTMLOptionElement>(`option[value='native:${NATIVE_SOL_MINT}']`)!;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain("SOL deposits are temporarily unavailable");
    expect(container.querySelector<HTMLOptionElement>(`option[value='token:${usdc}']`)!.disabled).toBe(false);
    expect(container.querySelector("[data-testid='sol-input-disabled-note']")!.textContent)
      .toBe("SOL deposits are temporarily unavailable — please use another token.");
    expect(mocks.controller!.inputKind).toBe("token");
    expect(mocks.controller!.inputMint).toBe(usdc);
  });

  it("blocks the action with the SOL note when SOL is the only input in the wallet", async () => {
    stubWallet([solAsset]);
    await act(async () => { root.render(createElement(OpenPositionModal, { pair, onClose: vi.fn() })); });
    await advance(1);
    expect(mocks.controller!.selectedAsset).toBeNull();
    expect(mocks.controller!.actionDisabled).toBe(true);
    expect(mocks.controller!.walletBlockedReason).toBe("SOL deposits are temporarily unavailable — please use another token.");
  });

  it("leaves SOL selectable and the default unchanged when the switch is on", async () => {
    solInputFlag.enabled = true;
    stubWallet([solAsset, usdcAsset]);
    await act(async () => { root.render(createElement(OpenPositionModal, { pair, onClose: vi.fn() })); });
    await advance(1);
    expect(container.querySelector<HTMLOptionElement>(`option[value='native:${NATIVE_SOL_MINT}']`)!.disabled).toBe(false);
    expect(container.querySelector("[data-testid='sol-input-disabled-note']")).toBeNull();
    expect(mocks.controller!.inputMint).toBe(usdc);
  });
});
