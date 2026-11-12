// @vitest-environment happy-dom
/**
 * Try again through the real pipeline and Buy adapter: it must confirm the terms on screen, never the ones saved when
 * Buy was first pressed (review of #327: an auto-refresh raised the minimum shown, and Try again sent the older, lower
 * one, so a route below the minimum on screen reached the wallet).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotSwapQuoteResult } from "@/lib/stock-market/spot-swap-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WALLET = "Wallet11111111111111111111111111111111111111";
const signTransaction = vi.fn();
const signAndSendTransaction = vi.fn();
const wallet = { address: WALLET, connected: true, connect: vi.fn(), signTransaction, signAndSendTransaction };
const post = vi.fn();
const fetchSpotSwapQuote = vi.fn();
vi.mock("@/components/wallet-connection", () => ({ useWalletConnection: () => wallet }));
vi.mock("@/lib/jupiter/browser-relay", () => ({ createJupiterRelayStore: () => ({}), postWithJupiterRelay: (...args: unknown[]) => post(...args) }));
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn(), captureTxWalletErrorLanded: vi.fn(), captureTxPreflightEvent: vi.fn() }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));
vi.mock("@/lib/stock-market/spot-swap-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stock-market/spot-swap-client")>()),
  fetchSpotSwapQuote: (...args: unknown[]) => fetchSpotSwapQuote(...args),
}));

const { SpotSwapModal, QUOTE_REFRESH_MS } = await import("./spot-swap-modal");
const { resetTxNotices } = await import("@/lib/tx-pipeline");

const option = { underlying: "TSLA", company: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", mintShort: "XsDo…HzoB", issuerName: "xStocks", symbol: "TSLAx" };
const FUNDED = { walletLamports: "50000000", outputAccountExists: true, requiredLamports: "5000", solSufficient: true, usdcBalance: "5000000", usdcSufficient: true };
const quoteWith = (quotedOut: string, minOut: string): SpotSwapQuoteResult => ({
  underlying: "TSLA", wallet: FUNDED,
  quote: { outputMint: option.mint, outputMintShort: "XsDo…HzoB", outputSymbol: "TSLAx", issuerName: "xStocks", xstocks: true, amount: "2000000", feeBps: 10,
    feeAmount: "2000", feeWalletShort: "CS5C…AK", quotedOut, minOut, priceImpactPct: "0.0012", newAccountRentLamports: 2_039_280, baseNetworkFeeLamports: 5000,
    outputDecimals: 8, slippageBps: 100 },
});
const refused = () => Response.json({ error: "Couldn't prepare the purchase. Nothing was sent; please try again." }, { status: 500 });

let host: HTMLDivElement; let root: Root;
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label) as HTMLButtonElement | undefined;
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers(); resetTxNotices();
  post.mockReset(); fetchSpotSwapQuote.mockReset(); signTransaction.mockReset(); signAndSendTransaction.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<SpotSwapModal option={option} onClose={() => undefined} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("SpotSwapModal Try again (real pipeline + adapter)", () => {
  it("confirms the minimum on screen after a refresh raised it, not the one from the first Buy", async () => {
    fetchSpotSwapQuote.mockResolvedValue(quoteWith("1010101", "1000000"));
    const input = host.querySelector('[data-testid="spot-swap-amount"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await advance(600);
    post.mockImplementation(async () => refused());
    await act(async () => (host.querySelector('[data-testid="spot-swap-submit"]') as HTMLButtonElement).click());
    await advance(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![1]).toMatchObject({ minOut: "1000000" });
    expect(button("Try again")).toBeDefined();

    // The price refreshes while the error is shown: the minimum on screen goes up.
    fetchSpotSwapQuote.mockResolvedValue(quoteWith("2020202", "2000000"));
    await advance(QUOTE_REFRESH_MS); await advance(600);
    expect(text("spot-swap-quoted")).toBe("0.020202 TSLAx");

    // The review's case: prepare answers with a route whose minimum (1,500,000) is above the first Buy's but below the
    // one on screen. It must not reach the wallet.
    post.mockImplementation(async () => Response.json({ unsignedTransaction: "not-reached", summary: {
      wallet: WALLET, outputMint: option.mint, amount: "2000000", quotedOut: "1515151", minOut: "1500000", outputDecimals: 8, outputSymbol: "TSLAx", lastValidBlockHeight: 1 } }));
    await act(async () => button("Try again")!.click());
    await advance(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![1]).toMatchObject({ minOut: "2000000", amount: "2", mint: option.mint });
    expect(signTransaction).not.toHaveBeenCalled(); expect(signAndSendTransaction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("does not match your request");
  });

  it("refuses Try again with nothing prepared when no price is on screen", async () => {
    fetchSpotSwapQuote.mockResolvedValue(quoteWith("1010101", "1000000"));
    const input = host.querySelector('[data-testid="spot-swap-amount"]') as HTMLInputElement;
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await advance(600);
    };
    await type("2");
    post.mockImplementation(async () => refused());
    await act(async () => (host.querySelector('[data-testid="spot-swap-submit"]') as HTMLButtonElement).click());
    await advance(0);
    await type("");
    await act(async () => button("Try again")!.click());
    await advance(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Wait for the price to load");
  });
});
