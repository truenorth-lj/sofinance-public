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

function quote(passesFloor = true): OpenPositionQuote {
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
    resaleInput: passesFloor ? "119000000" : "117000000", minimumResaleInput: "118800000",
    roundtripCostInput: passesFloor ? "1000000" : "3000000", slippageBps: 50,
    routeTouchesTargetPool: false, token2022A: true, token2022B: false,
    freezeRiskA: true, freezeRiskB: false, freezeRisk: true,
    transferFee: false, paused: false, frozen: false, unsupportedExtensions: [],
    passesFloor, floorBps: 9900, maxImpactBps: 500, tickLower: -26, tickUpper: 94,
    rangeSide: "inside", warnings: [], solLamports: "226500000", networkFeeLamportsEstimate: "50000",
    rent: {
      refundableLamports: "7800000", nonRefundableLamports: "1800000",
      positionNftLamports: "2000000", nftAtaLamports: "2000000", personalPositionLamports: "3800000",
      tickArrayLamports: "0", protocolPositionLamports: "1800000",
      tickArrayInitRequired: false, protocolPositionInitRequired: true, tickArrayAccounts: [],
    },
    requiredSolLamports: "139650000", sufficientSol: true, sufficientInput: true, slot: 1,
    fetchedAt: Date.now(), expiresAt: Date.now() + QUOTE_TTL_MS,
  };
}

let root: Root;
let container: HTMLDivElement;
let passesFloor: boolean;
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
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign")!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.wallet = "wallet";
  mocks.controller = null;
  passesFloor = true;
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
      return { ok: !failQuote, json: async () => failQuote ? { error: "Quote service unavailable" } : quote(passesFloor) };
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
  it("explains a failed resale floor and displays the amounts instead of asking to complete the form", async () => {
    passesFloor = false;
    await mount();
    expect(signButton().disabled).toBe(true);
    expect(container.textContent).toContain("below the 99.0% minimum");
    expect(container.textContent).toContain("0.117 SOL");
    expect(container.textContent).toContain("0.1188 SOL");
    expect(container.textContent).not.toContain("Complete the form to sign");
    expect(signButton().title).toContain("99.0%");
  });

  it("refreshes at expiry, keeps signing disabled while refreshing, and accepts the new quote", async () => {
    await mount();
    expect(signButton().disabled).toBe(false);
    await advance(QUOTE_TTL_MS + 1000);
    expect(signButton().disabled).toBe(true);
    expect(container.textContent).toMatch(/expired|Fetching quote/);
    await advance(450);
    expect(quoteCalls).toBe(2);
    expect(signButton().disabled).toBe(false);
    await advance(5000);
    expect(quoteCalls).toBe(2);
  });

  it("lets the user retry a failed refresh without editing a valid amount", async () => {
    await mount();
    failQuote = true;
    await advance(QUOTE_TTL_MS + 1000);
    await advance(450);
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
    await advance(10000);
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
    await act(async () => { mocks.controller!.changeAmount(""); });
    await act(async () => { resolveQuote({ ok: true, json: async () => quote() }); });
    expect(mocks.controller!.quote).toBeNull();
    expect(mocks.controller!.quoteLoading).toBe(false);
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
});
