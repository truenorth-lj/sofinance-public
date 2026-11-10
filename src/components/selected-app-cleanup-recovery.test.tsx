// @vitest-environment happy-dom
// Real SelectedApp, Add controller and Compound controller; stop at the offline prepare boundary.
import { act, createElement, useLayoutEffect, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import type { CompoundController } from "./use-compound-controller";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { loadCompoundReceipts, persistCompoundReceipt } from "@sofinance/engine/compound-attempt";
import { USDC_MINT } from "@sofinance/engine/ids";

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
const probe = vi.hoisted(() => ({ current: null as CompoundController | null,
  commits: [] as { mint: string | undefined; canCompound: boolean; canCleanup: boolean }[] }));
vi.mock("./use-compound-controller", async (load) => {
  const original = await load<typeof import("./use-compound-controller")>();
  return { useCompoundController: (args: Parameters<typeof original.useCompoundController>[0]) => {
    const result = original.useCompoundController(args);
    useLayoutEffect(() => {
      probe.current = result;
      probe.commits.push({ mint: result.positionMint, canCompound: result.canCompound, canCleanup: result.canCleanup });
      // Exercise the command guard too, not only the disabled primary button.
      if (!result.positionMint) result.compound();
    });
    return result;
  } };
});

const fixture = compoundHistoryFixture();
const otherMint = compoundHistoryFixture().state.mintA;
const position = (positionMint: string) => ({ ...fixture.state, positionMint, symbolA: "AAA", symbolB: "BBB",
  liquidity: "1", feeTierBps: 1, tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside" });
let container: HTMLDivElement;
let root: Root;
let calls: { url: string; body: Record<string, unknown> | null }[];
let positions: string[];
let eligible: boolean;
const sign = vi.fn(async () => { throw new Error("Signing is forbidden in this regression test"); });
const send = vi.fn(async () => { throw new Error("Sending is forbidden in this regression test"); });
const settle = async () => { for (let i = 0; i < 20; i++) await act(async () => { await vi.advanceTimersByTimeAsync(100); }); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith(label))!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  calls = []; positions = []; eligible = false; probe.current = null; probe.commits = [];
  sign.mockClear(); send.mockClear();
  persistCompoundReceipt(localStorage, { wallet: fixture.wallet, positionMint: fixture.state.positionMint,
    sourceSignature: fixture.attempt.signature, compoundAccounts: fixture.attempt.summary.compoundAccounts });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/wallet?")) return Response.json({ wallet: fixture.wallet, slot: 1, fetchedAt: 1,
      positions: positions.map(position), assets: eligible ? [{ kind: "token", mint: USDC_MINT, decimals: 6,
        balance: "1000000", totalBalance: "1000000", account: fixture.state.nftAta, tokenProgram: null, eligible: true, reason: null }] : [] });
    if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: JSON.parse(String(init?.body)).positionMint });
    // A deliberate prepare rejection proves reachability, without constructing/signing/sending any transaction.
    if (url.endsWith("-prepare")) return Response.json({ error: "Offline prepare boundary reached" }, { status: 400 });
    return Response.json({});
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); localStorage.clear();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function mount() {
  const connection: WalletConnection = { address: fixture.wallet, connected: true, connect: vi.fn(), disconnect: vi.fn(),
    isMobile: false, walletsCount: 1, connectionError: "", signTransaction: sign, signAndSendTransaction: send };
  await act(async () => root.render(createElement(WalletConnectionContext.Provider, { value: connection },
    createElement(SelectedApp as FunctionComponent<{ initialView: "compound" }>, { initialView: "compound" }))));
  await settle();
}

describe("All positions wallet-wide leftover recovery", () => {
  it.each([
    ["zero LP", false, "Clean up all balances", "/api/compound-cleanup-prepare"],
    ["zero LP", false, "Retrieve this balance", "/api/compound-recover-prepare"],
    ["LP without eligible input", true, "Clean up all balances", "/api/compound-cleanup-prepare"],
    ["LP without eligible input", true, "Retrieve this balance", "/api/compound-recover-prepare"],
  ] as const)("%s: %s %s reaches only wallet recovery prepare", async (_case, hasPosition, label, endpoint) => {
    // The saved receipt belongs to an NFT no longer held, even when a different LP remains.
    positions = hasPosition ? [otherMint] : [];
    eligible = !hasPosition; // Zero LP still has spendable USDC; the other case isolates missing input.
    await mount();
    expect(probe.current?.positionMint).toBeUndefined();
    expect(probe.current?.receipts).toHaveLength(1);
    expect(probe.current?.canCompound).toBe(false);
    expect(probe.current?.canCleanup).toBe(true);
    expect(probe.current?.ready).toBe(true);
    expect(button("One-click compound").disabled).toBe(true);
    expect(button("Clean up all balances").disabled).toBe(false);
    expect(button("Retrieve this balance").disabled).toBe(false);
    await act(async () => button(label).click()); await settle();
    expect(calls.filter(c => c.url.endsWith("-prepare"))).toEqual([{ url: endpoint,
      body: { wallet: fixture.wallet, compoundAccounts: fixture.attempt.summary.compoundAccounts } }]);
    expect(loadCompoundReceipts(localStorage, fixture.wallet).receipts).toHaveLength(1);
    expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("keeps position compound fenced during read-only B to eligible-input reconciliation", async () => {
    positions = [fixture.state.positionMint, otherMint];
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="position-fallback-select"][data-position-key="raydium-clmm:${otherMint}"]`)!.click());
    await settle();
    const before = probe.commits.length;
    eligible = true;
    await act(async () => button("Rescan wallet").click()); await settle();
    const transition = probe.commits.slice(before);
    expect(transition.some(c => c.mint === undefined)).toBe(true);
    expect(transition.filter(c => !c.mint).every(c => !c.canCompound && c.canCleanup)).toBe(true);
    expect(transition.filter(c => c.mint).every(c => c.mint === otherMint)).toBe(true);
    expect(probe.current?.positionMint).toBe(otherMint);
    expect(probe.current?.canCompound).toBe(true);
    expect(calls.filter(c => c.url.endsWith("-prepare"))).toEqual([]);
    expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
