// @vitest-environment happy-dom
// /app My positions with DEXes served through the registry (PR5): their rows join the Solana group, header/details and
// tools come only from the unified shape and the descriptor's capabilities; a deployment that does not serve the route
// (404, production today) renders exactly the Raydium-only page.
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "../selected-app";
import { testKeypair } from "@/lib/test-support/send-fixtures";

const WALLET = testKeypair(91).publicKey.toBase58();
const RAYDIUM_MINT = testKeypair(92).publicKey.toBase58();
const POOL = testKeypair(93).publicKey.toBase58();
const POSITION = testKeypair(94).publicKey.toBase58();
const MINT_A = testKeypair(95).publicKey.toBase58();
const MINT_B = testKeypair(96).publicKey.toBase58();
const state = vi.hoisted(() => ({ dex: { status: 200, body: {} as unknown }, raydium: [] as unknown[], dexCalls: [] as unknown[] }));

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("../use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("../use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("../transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("../wallet-connection", async (importOriginal) => ({ ...await importOriginal<typeof import("../wallet-connection")>(),
  useWalletConnection: () => ({ address: WALLET, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1,
    connectionError: "", signTransaction: vi.fn() }) }));

const meteoraRow = (liquidity = "5000") => ({ key: `meteora-dlmm:${POSITION}`, source: "meteora-dlmm", chain: "solana", nativeId: POSITION, poolId: POOL,
  tokenA: { id: MINT_A, symbol: "TSLAx", decimals: 8 }, tokenB: { id: MINT_B, symbol: "TSLA", decimals: 8 },
  range: { mode: "price", lower: 0.98, upper: 1.02, current: 1 }, rangeStatus: "in", liquidity, valueUsd: null, native: { position: POSITION } });
const raydiumRow = { positionMint: RAYDIUM_MINT, positionAccount: "p", poolId: POOL, mintA: MINT_A, mintB: MINT_B, symbolA: "A", symbolB: "B",
  decimalsA: 8, decimalsB: 6, feeTierBps: 1, tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1" };

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  state.dex = { status: 200, body: { positions: [meteoraRow()] } }; state.raydium = []; state.dexCalls = [];
  window.history.replaceState(null, "", "/app");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/wallet") return Response.json({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: state.raydium, assets: [] });
    if (url.pathname.startsWith("/api/dex/")) {
      state.dexCalls.push([url.pathname, JSON.parse(String(init?.body))]);
      return state.dex.status === 404 ? new Response(null, { status: 404 }) : Response.json(state.dex.body, { status: state.dex.status });
    }
    return Response.json({ error: "not in this test" }, { status: 503 });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
async function render(props: Record<string, unknown> = {}) {
  await act(async () => root.render(createElement(SelectedApp as FunctionComponent<Record<string, unknown>>, props)));
  await settle();
}
const select = () => container.querySelector<HTMLSelectElement>("select#position")!;
const groups = () => [...select().querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]);
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("nav[aria-label='Position operations'] button")].find((b) => b.textContent === label)!;

describe("/app My positions with registry DEXes", () => {
  it("lists the wallet's served-DEX positions in the Solana group and selects one when the scan has none", async () => {
    await render();
    expect(state.dexCalls).toEqual([["/api/dex/meteora-dlmm/positions", { owner: WALLET }]]);
    expect(groups()).toEqual([["Solana", [`Meteora · TSLAx/TSLA · range 0.9800–1.0200 · In range · #${POSITION.slice(0, 4)}…${POSITION.slice(-4)}`]]]);
    expect(select().value).toBe(`meteora-dlmm:${POSITION}`);
    expect(container.querySelector("[data-testid=registry-position-header]")?.textContent).toBe("In rangeRange 0.9800–1.0200");
    // Every tool is unavailable for this DEX today: greyed tabs and the descriptor's reason, never the Raydium panels.
    expect(container.querySelector("#compound-view")?.textContent).toContain("Not available for Meteora positions yet");
    expect(container.querySelector("#withdraw-view, #deposit-view")).toBeNull();
    expect(tab("Withdraw")).toBeTruthy();
  });

  it("a ?position= deep link to a registry position selects it over the scanned positions", async () => {
    state.raydium = [raydiumRow];
    await render({ initialPositionKey: `meteora-dlmm:${POSITION}` });
    expect(select().value).toBe(`meteora-dlmm:${POSITION}`);
    expect(groups()[0]![1]).toHaveLength(2);
  });

  it("a deployment that does not serve the route (404) renders the Raydium-only page: no source names, no Meteora text", async () => {
    state.dex = { status: 404, body: null }; state.raydium = [raydiumRow];
    await render();
    const [[label, options]] = groups() as [[string, string[]]];
    expect(label).toBe("Solana");
    expect(options).toHaveLength(1);
    expect(options[0]).not.toMatch(/Raydium|Meteora/);
    expect(container.textContent).not.toContain("Meteora");
  });

  it("a DEX that fails shows its plain error and leaves the scanned positions usable", async () => {
    state.dex = { status: 502, body: { error: "Solana RPC is temporarily unavailable. Try again shortly." } }; state.raydium = [raydiumRow];
    await render();
    expect(container.querySelector("[data-testid=registry-positions-error]")?.textContent)
      .toBe("Meteora: Solana RPC is temporarily unavailable. Try again shortly.");
    expect(select().value).toBe(`raydium-clmm:${RAYDIUM_MINT}`);
  });

  it("rejects a response whose rows are not this DEX's positions", async () => {
    state.dex = { status: 200, body: { positions: [{ ...meteoraRow(), source: "raydium-clmm" }] } };
    await render();
    expect(container.querySelector("[data-testid=registry-positions-error]")?.textContent).toBe("Meteora: Meteora returned positions in an unexpected shape.");
    expect(container.textContent).not.toContain("TSLAx/TSLA");
  });
});
