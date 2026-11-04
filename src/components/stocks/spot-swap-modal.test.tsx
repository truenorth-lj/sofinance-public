// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotSwapQuoteResult } from "@/lib/stock-market/spot-swap-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wallet = { address: null as string | null, connected: false, connect: vi.fn(), signTransaction: vi.fn(), signAndSendTransaction: vi.fn() };
const run = vi.fn();
const fetchSpotSwapQuote = vi.fn();
vi.mock("@/components/wallet-connection", () => ({ useWalletConnection: () => wallet }));
vi.mock("@/components/transactions/use-tx-pipeline", () => ({
  useTxPipeline: () => ({ status: "idle", locked: false, closeLocked: false, busy: false, run }),
}));
vi.mock("@/components/unified-positions/registry-tools", () => ({ BUTTON: "", FIELD: "", TxStatus: () => null }));
vi.mock("@/lib/stock-market/spot-swap-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stock-market/spot-swap-client")>()),
  fetchSpotSwapQuote: (...args: unknown[]) => fetchSpotSwapQuote(...args),
}));

const { SpotSwapModal, amountProblem } = await import("./spot-swap-modal");
const { SpotSwapQuoteError } = await import("@/lib/stock-market/spot-swap-client");

const option = { underlying: "TSLA", company: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", mintShort: "XsDo…oB", issuerName: "xStocks", symbol: "TSLAx" };
const quote: SpotSwapQuoteResult = {
  underlying: "TSLA",
  quote: { outputMint: option.mint, outputMintShort: "XsDo…oB", outputSymbol: "TSLAx", issuerName: "xStocks", xstocks: true, amount: "2000000", feeBps: 10, feeAmount: "2000",
    feeWalletShort: "CS5C…AK", quotedOut: "4500000", minOut: "4477500", priceImpactPct: "0.0012", newAccountRentLamports: 2_039_280, baseNetworkFeeLamports: 5000,
    outputDecimals: 8, slippageBps: 50 },
  wallet: null,
};

let host: HTMLDivElement; let root: Root;
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
async function typeAmount(value: string) {
  const input = host.querySelector('[data-testid="spot-swap-amount"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(wallet, { address: null, connected: false });
  fetchSpotSwapQuote.mockReset(); run.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<SpotSwapModal option={option} onClose={() => undefined} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("SpotSwapModal", () => {
  it("shows the issuer, short mint, region notice and a connect button before a wallet", () => {
    expect(text("spot-swap-issuer")).toBe("xStocks · XsDo…oB");
    expect(text("spot-swap-notice")).toBe("Not available to US persons or restricted regions. Tokens are issued by third parties.");
    expect(text("spot-swap-connect")).toBe("Connect wallet to buy");
  });

  it("shows the quote compact: received and one summary row; details (minimum, our 0.1% fee, deposit) only when expanded", async () => {
    fetchSpotSwapQuote.mockImplementation(async () => quote);
    await typeAmount("2");
    expect(fetchSpotSwapQuote).toHaveBeenCalledWith(expect.objectContaining({ underlying: "TSLA", amount: "2", wallet: null }));
    expect(text("spot-swap-quoted")).toContain("TSLAx");
    const summary = document.querySelector('[data-testid="spot-swap-summary"]') as HTMLButtonElement;
    expect(summary.tagName).toBe("BUTTON");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("Price impact 0.12% · Fee 0.1%");
    expect(summary.dataset.highImpact).toBeUndefined();
    expect(document.querySelector('[data-testid="spot-swap-min"]')).toBeNull();
    expect(document.querySelector('[data-testid="spot-swap-fee"]')).toBeNull();
    await act(async () => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(text("spot-swap-min")).toContain("TSLAx");
    expect(text("spot-swap-quote")).toContain("SoFinance fee (0.1%)");
    expect(text("spot-swap-fee")).toContain("0.002");
    expect(text("spot-swap-deposit")).toContain("SOL");
    expect(text("spot-swap-quote")).toContain("refundable");
  });

  it("turns the summary row warning-coloured when price impact is high", async () => {
    fetchSpotSwapQuote.mockImplementation(async () => ({ ...quote, quote: { ...quote.quote, priceImpactPct: "0.007" } }));
    await typeAmount("2");
    expect((document.querySelector('[data-testid="spot-swap-summary"]') as HTMLElement).dataset.highImpact).toBe("true");
  });

  it("refuses with the engine's price-impact words, with no error codes", async () => {
    const message = "There isn't enough trading liquidity to buy this amount without moving the price more than 1%. Try a smaller amount.";
    fetchSpotSwapQuote.mockImplementation(async () => { throw new SpotSwapQuoteError(message, "spot_swap_price_impact"); });
    await typeAmount("50000");
    expect(text("spot-swap-refused")).toBe(message);
    expect(host.textContent).not.toMatch(/spot_swap_|cancelled/);
  });

  it("warns when SOL is too low and keeps Buy disabled", async () => {
    Object.assign(wallet, { address: "Wallet11111111111111111111111111111111111111", connected: true });
    act(() => root.render(<SpotSwapModal option={option} onClose={() => undefined} />));
    fetchSpotSwapQuote.mockImplementation(async () => ({ ...quote, wallet: { walletLamports: "1000000", outputAccountExists: false, requiredLamports: "2044280", solSufficient: false, usdcBalance: "5000000", usdcSufficient: true } }));
    await typeAmount("2");
    expect(text("spot-swap-sol-low")).toMatch(/^Not enough SOL: this purchase needs about .* SOL .* your wallet has .* SOL\. Add SOL and try again\.$/);
    expect((host.querySelector('[data-testid="spot-swap-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Buy with a funded wallet and runs the pipeline with the quoted mint", async () => {
    Object.assign(wallet, { address: "Wallet11111111111111111111111111111111111111", connected: true });
    act(() => root.render(<SpotSwapModal option={option} onClose={() => undefined} />));
    fetchSpotSwapQuote.mockImplementation(async () => ({ ...quote, wallet: { walletLamports: "50000000", outputAccountExists: true, requiredLamports: "5000", solSufficient: true, usdcBalance: "5000000", usdcSufficient: true } }));
    await typeAmount("2");
    expect(text("spot-swap-deposit")).toBeNull();
    const submit = host.querySelector('[data-testid="spot-swap-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Buy TSLAx");
    await act(async () => submit.click());
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ underlying: "TSLA", mint: option.mint, amount: "2" }));
  });
});

describe("amountProblem", () => {
  it("explains bad amounts in plain words", () => {
    expect(amountProblem("")).toBeNull();
    expect(amountProblem("25")).toBeNull();
    expect(amountProblem("abc")).toBe("Enter a number, for example 25.");
    expect(amountProblem("1.1234567")).toBe("USDC has at most 6 decimals.");
    expect(amountProblem("0")).toBe("Enter an amount above zero.");
    expect(amountProblem("2000000")).toBe("Enter a smaller amount.");
  });
});
