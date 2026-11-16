// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGrowthClientForTests, resetGrowthAnalyticsForTests } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { resetWalletConnectSessionForTests } from "@/lib/analytics/wallet-connect-session";
import { useSolanaConnectFlow } from "./use-solana-connect-flow";

const capture = vi.fn();
let container: HTMLDivElement;
let root: Root;
const live = {} as { flow: ReturnType<typeof useSolanaConnectFlow> };

function Host({ openModal }: { openModal: () => void }) {
  const flow = useSolanaConnectFlow(openModal);
  useEffect(() => { live.flow = flow; });
  return flow.sheetOpen ? createElement("div", { "data-testid": "sheet" }) : null;
}

async function render(openModal: () => void) {
  await act(async () => {
    root.render(createElement(Host, { openModal }));
  });
}

describe("useSolanaConnectFlow", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetGrowthAnalyticsForTests();
    resetWalletConnectSessionForTests();
    capture.mockReset();
    installGrowthClientForTests({ capture, register: vi.fn(), identify: vi.fn() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    for (const key of ["solana", "phantom", "solflare", "backpack", "glow"] as const) {
      delete (window as unknown as Record<string, unknown>)[key];
    }
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetGrowthAnalyticsForTests();
    resetWalletConnectSessionForTests();
    vi.unstubAllGlobals();
  });

  it("opens the existing modal on desktop and does not show the deeplink sheet", async () => {
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0" });
    Object.defineProperty(window.navigator, "userAgentData", { configurable: true, value: { mobile: false } });
    Object.defineProperty(window.navigator, "maxTouchPoints", { configurable: true, value: 0 });
    const openModal = vi.fn();
    await render(openModal);
    await act(async () => { live.flow.connect(); });
    expect(openModal).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-testid=sheet]")).toBeNull();
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectClicked, undefined);
  });

  it("opens the deeplink sheet on mobile when no injected wallet is present", async () => {
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    Object.defineProperty(window.navigator, "userAgentData", { configurable: true, value: { mobile: true } });
    const openModal = vi.fn();
    await render(openModal);
    await act(async () => { live.flow.connect(); });
    expect(openModal).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid=sheet]")).not.toBeNull();
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectClicked, undefined);
  });

  it("does not open the sheet on mobile when an injected wallet is present", async () => {
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    Object.defineProperty(window.navigator, "userAgentData", { configurable: true, value: { mobile: true } });
    (window as unknown as { solana: object }).solana = {};
    const openModal = vi.fn();
    await render(openModal);
    await act(async () => { live.flow.connect(); });
    expect(openModal).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-testid=sheet]")).toBeNull();
  });

  it("fires abandoned once when the sheet is closed, and not again after a later close", async () => {
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    Object.defineProperty(window.navigator, "userAgentData", { configurable: true, value: { mobile: true } });
    await render(vi.fn());
    await act(async () => { live.flow.connect(); });
    await act(async () => { live.flow.closeSheet(); });
    await act(async () => { live.flow.closeSheet(); });
    const abandoned = capture.mock.calls.filter((call) => call[0] === GROWTH_EVENTS.walletConnectAbandoned);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]![1]).toMatchObject({ chain: "solana", device: "mobile", wallet_extension_detected: false });
  });

  it("opens the existing modal from the sheet without firing abandoned", async () => {
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    Object.defineProperty(window.navigator, "userAgentData", { configurable: true, value: { mobile: true } });
    const openModal = vi.fn();
    await render(openModal);
    await act(async () => { live.flow.connect(); });
    expect(container.querySelector("[data-testid=sheet]")).not.toBeNull();
    await act(async () => { live.flow.chooseWalletHere(); });
    expect(openModal).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-testid=sheet]")).toBeNull();
    expect(capture.mock.calls.map((call) => call[0])).not.toContain(GROWTH_EVENTS.walletConnectAbandoned);
  });

  it("records started and wallet_deeplink_clicked when a wallet link is opened", async () => {
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    Object.defineProperty(window.navigator, "userAgentData", { configurable: true, value: { mobile: true } });
    await render(vi.fn());
    await act(async () => { live.flow.connect(); live.flow.openWallet("Phantom"); });
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectStarted, expect.objectContaining({
      wallet_name: "Phantom", chain: "solana", device: "mobile", wallet_extension_detected: false,
    }));
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletDeeplinkClicked, expect.objectContaining({
      wallet_name: "Phantom", chain: "solana",
    }));
  });
});
