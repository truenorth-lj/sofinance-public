// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { dexDescriptors } from "@/lib/dex/client";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import type { UnifiedPool } from "@/lib/unified-pools/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const WALLET = "EweT1111111111111111111111111111111111111111";
const mocks = vi.hoisted(() => ({ runSteps: vi.fn(async () => null), tx: {} as Record<string, unknown> }));
vi.mock("../wallet-connection", () => ({ useWalletConnection: () => ({ address: WALLET, connected: true, connect: vi.fn(), signTransaction: vi.fn(), signAndSendTransaction: vi.fn() }) }));
vi.mock("../transactions/use-tx-pipeline", () => ({ useTxPipeline: () => ({ status: "idle", locked: false, closeLocked: false, runSteps: mocks.runSteps, retry: vi.fn(), interrupted: null, dismissInterrupted: vi.fn(), ...mocks.tx }) }));

import { openInputs, presetOptions, RegistryOpenModal, NETWORK_FEE_COPY, SOL_REFUSED_COPY } from "./registry-open-modal";

const descriptor = dexDescriptors.descriptorFor("meteora-dlmm")!;
const pool = { key: "solana:met1", poolAddress: "met1", chain: "solana", protocol: "meteora-dlmm", pairLabel: "TSLAx/TSLA", symbolA: "TSLAx", symbolB: "TSLA",
  mintA: "mintA", mintB: "mintB" } as unknown as UnifiedPool;
// Bin step 10: "ticks" are bin ids × 10, so units = (upper − lower) / 10.
const presets = [
  { id: "micro", tickLower: -20, tickUpper: 20, priceLower: 0.99, priceUpper: 1.01 },
  { id: "standard", tickLower: -300, tickUpper: 300, priceLower: 0.9, priceUpper: 1.1 },
  { id: "wide", tickLower: -1000, tickUpper: 1000, priceLower: 0.5, priceUpper: 1.5 },
] as const;
const payload = { pool: { tickSpacing: 10, decimalsA: 8, decimalsB: 8 }, presets } as unknown as PoolRangeAprPayload;

describe("presetOptions / openInputs", () => {
  it("offers presets up to the descriptor's per-position cap; wider ones say not available to open yet", () => {
    const options = presetOptions(presets, 10, descriptor);
    expect(options.map((item) => [item.id, item.units, item.available])).toEqual([["micro", 4, true], ["standard", 60, true], ["wide", 200, false]]);
    expect(options[2]!.reason).toBe("Not available to open yet: this range spans 200 bins, and one position holds at most 70.");
  });
  it("never offers native SOL as an input", () => {
    const tokens = openInputs({ ...pool, mintB: NATIVE_SOL_MINT, symbolB: "SOL" }, descriptor, { a: 8, b: 9 });
    expect(tokens.map((item) => item.id)).toEqual(["mintA", USDC_MINT]);
  });
});

let root: Root; let container: HTMLDivElement; let quoteBody: Record<string, unknown>; let calls: { url: string; body: unknown }[];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.tx = {}; mocks.runSteps.mockClear(); calls = [];
  quoteBody = { poolId: "met1", range: { lowerPrice: 0.9, upperPrice: 1.1, units: 60 }, steps: 2, platformFeeRaw: "1000",
    rent: { refundableLamports: "41899840", nonRefundableLamports: "0", tokenAccountLamports: "2039280" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/wallet")) return Response.json({ assets: [{ kind: "native", mint: NATIVE_SOL_MINT, balance: "1000000000" }, { kind: "token", mint: USDC_MINT, balance: "5000000" }] });
    return Response.json(quoteBody);
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = async (props: Partial<Parameters<typeof RegistryOpenModal>[0]> = {}) =>
  act(async () => root.render(createElement(RegistryOpenModal, { pool, descriptor, ranges: payload, onClose: vi.fn(), ...props })));
const type = async (value: string) => {
  const input = container.querySelector<HTMLInputElement>("#registry-open-amount")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
};
const openButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Open position"))!;

describe("RegistryOpenModal", () => {
  it("quotes the default preset through the registry route and shows rent, the 0.1% fee, the wallet fee and SOL reserve notes", async () => {
    await render();
    expect(container.querySelector<HTMLButtonElement>("[data-testid=registry-open-preset-wide]")!.disabled).toBe(true);
    expect(container.textContent).toContain("Not available to open yet");
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
    expect(costs).toContain("Phantom added about 0.0015 SOL on step 2");
    expect(openButton().disabled).toBe(false);
    await act(async () => { openButton().click(); });
    expect(mocks.runSteps).toHaveBeenCalledTimes(1);
    const [first] = mocks.runSteps.mock.calls[0] as unknown as [{ request: unknown; context: unknown }];
    expect(first.request).toEqual({ poolId: "met1", range: { kind: "preset", presetId: "standard" }, input: { token: USDC_MINT, amountRaw: "1000000" }, slippageBps: 50 });
    expect(first.context).toEqual({ step: 1, priorSignatures: [] });
  });

  it("a quote that needs a new shared account is blocked with its reason and no Open", async () => {
    quoteBody = { ...quoteBody, blockedReason: "This range needs a shared Meteora account (a bin array) that doesn't exist yet." };
    await render();
    await type("1");
    expect(container.querySelector("[data-testid=registry-open-blocked]")!.textContent).toContain("bin array");
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
    await render({ pool: { ...pool, mintB: NATIVE_SOL_MINT, symbolB: "SOL" } as UnifiedPool });
    expect(container.querySelector("[data-testid=registry-open-sol]")!.textContent).toBe(SOL_REFUSED_COPY);
    expect([...container.querySelectorAll("#registry-open-token option")].map((o) => o.textContent)).toEqual(["TSLAx", "USDC"]);
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
