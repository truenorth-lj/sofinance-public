// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SOL_MINT, QUOTE_TTL_MS } from "../lib/ids";
import type { OpenPositionQuote } from "../lib/open-types";
import { OpenPositionModal } from "./open-position-modal";
import type { OpenPositionPair, useOpenPositionController } from "./use-open-position-controller";

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
    wallet: mocks.wallet, poolId: pair.poolAddress, inputMint: NATIVE_SOL_MINT, inputKind: "native",
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
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/wallet")) return { ok: true, json: async () => ({ assets: [{
      kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "216474000", eligible: true,
    }] }) };
    if (url === "/api/open-quote") {
      quoteCalls++;
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

describe("open-position signing and quote refresh", () => {
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
        kind: "native", mint: NATIVE_SOL_MINT, decimals: 9, balance: "216474000", eligible: true,
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
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Estimated round-trip cost: about 10.00% (assuming you open the position, immediately withdraw, and swap back to SOL). This conservative estimate includes swap fees, price impact, and slippage tolerance. It does not block signing.");
    expect(container.querySelector('[role="tooltip"]')?.classList.contains("bg-char")).toBe(true);
    await act(async () => {
      info.click();
      info.focus();
      info.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.textContent).not.toContain("Ready to sign");
  });

  it("fetches a new quote every three seconds without waiting for expiry", async () => {
    await mount();
    expect(signButton().disabled).toBe(false);
    await advance(2999);
    expect(quoteCalls).toBe(1);
    await advance(1);
    expect(quoteCalls).toBe(2);
    expect(signButton().disabled).toBe(false);
    await advance(3000);
    expect(quoteCalls).toBe(3);
  });

  it("lets the user retry a failed refresh without editing a valid amount", async () => {
    await mount();
    failQuote = true;
    await advance(3000);
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
    await advance(3000);
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
    await advance(3000);
    await advance(QUOTE_TTL_MS + 1000);
    expect(signButton().disabled).toBe(true);
    expect(quoteCalls).toBe(2);
  });

  it("starts preparation during a background refresh and ignores its late response", async () => {
    await mount();
    const previousQuote = mocks.controller!.quote;
    let resolveQuote!: (value: unknown) => void;
    deferredQuote = new Promise((resolve) => { resolveQuote = resolve; });
    await advance(3000);
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
