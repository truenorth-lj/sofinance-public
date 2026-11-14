// @vitest-environment happy-dom
// Raydium selection, deep links and 404/empty registry parity remain unchanged by registry discovery.
// The full-page snapshots intentionally track the new All positions layout (not the former My positions card).
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "../selected-app";
import { initialSelectionFromQuery } from "@/lib/unified-positions/url";
import { testKeypair } from "@/lib/test-support/send-fixtures";

const WALLET = testKeypair(71).publicKey.toBase58();
const FIRST = testKeypair(72).publicKey.toBase58();
const LINKED = testKeypair(73).publicKey.toBase58();
const POOL = testKeypair(74).publicKey.toBase58();
const MINT_A = testKeypair(75).publicKey.toBase58();
const MINT_B = testKeypair(76).publicKey.toBase58();
const state = vi.hoisted(() => ({ dexCalls: 0, dex: "404" as "404" | "empty" | "hang" | "500" }));

vi.mock("next/navigation", () => ({ usePathname: () => "/app/portfolio" }));
vi.mock("../use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("../use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("../transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("../wallet-connection", async (importOriginal) => ({ ...await importOriginal<typeof import("../wallet-connection")>(),
  useWalletConnection: () => ({ address: WALLET, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1,
    connectionError: "", signTransaction: vi.fn() }) }));

const raydiumRow = (positionMint: string, tickLower: number, tickUpper: number) => ({ positionMint, positionAccount: `acct-${tickLower}`, poolId: POOL,
  mintA: MINT_A, mintB: MINT_B, symbolA: "TSLAx", symbolB: "TSLA", decimalsA: 8, decimalsB: 8, feeTierBps: 1, tickLower, tickUpper, tickCurrent: 0,
  rangeSide: "inside", liquidity: "1000" });

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  state.dexCalls = 0; state.dex = "404";
  window.history.replaceState(null, "", "/app");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/wallet") {
      return Response.json({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: [raydiumRow(FIRST, -20, 20), raydiumRow(LINKED, -10, 10)], assets: [] });
    }
    if (url.pathname.startsWith("/api/dex/")) {
      state.dexCalls += 1;
      if (state.dex === "empty") return Response.json({ positions: [] });
      if (state.dex === "hang") return new Promise<Response>(() => {});
      if (state.dex === "500") return Response.json({ error: "Meteora is down" }, { status: 500 });
      return new Response(null, { status: 404 });
    }
    return Response.json({ error: "not in this test" }, { status: 503 });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
async function renderLinked() {
  const props = initialSelectionFromQuery({ position: `raydium-clmm:${LINKED}`, view: "deposit" });
  await act(async () => root.render(createElement(SelectedApp as FunctionComponent<Record<string, unknown>>, props)));
  await settle();
  // React's useId counter differs between roots; everything else is compared verbatim.
  return container.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_id_");
}
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="position-fallback-select"]')];
const selectedKey = () => rows().find((row) => row.getAttribute("aria-pressed") === "true")?.getAttribute("data-position-key");

describe("/app Raydium selected state (unchanged by the registry DEXes)", () => {
  it("?position=raydium-clmm:<mint> selects that Raydium position, and the panel matches the All positions snapshot", async () => {
    const html = await renderLinked();
    expect(selectedKey()).toBe(`raydium-clmm:${LINKED}`);
    expect(rows().map((row) => row.firstChild?.textContent).join("\n")).not.toMatch(/Raydium|Meteora/);
    expect(html).toMatchSnapshot();
  });

  it("keeps read-only selection reachable when no eligible input asset exists", async () => {
    await renderLinked();
    const target = rows().find((row) => row.getAttribute("data-position-key") === `raydium-clmm:${FIRST}`)!;
    await act(async () => target.click());
    await settle();
    expect(selectedKey()).toBe(`raydium-clmm:${FIRST}`);
    expect(new URL(window.location.href).searchParams.get("position")).toBe(`raydium-clmm:${FIRST}`);
  });

  const remount = async () => {
    await act(async () => root.unmount());
    container.remove(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  };

  it("with Meteora serving 0 positions, the Raydium markup is identical to a 404 (no source prefix)", async () => {
    const missing = await renderLinked();
    expect(state.dexCalls).toBe(1);
    await remount();
    state.dexCalls = 0; state.dex = "empty";
    const empty = await renderLinked();
    expect(state.dexCalls).toBe(1);
    expect(empty).toBe(missing);
    expect(rows().map((row) => row.firstChild?.textContent).join("\n")).not.toMatch(/Raydium|Meteora/);
    expect(empty).toMatchSnapshot();
  });

  it("a hanging Meteora positions read does not hold back the Raydium list or selection", async () => {
    state.dex = "hang";
    await renderLinked();
    expect(state.dexCalls).toBe(1);
    expect(selectedKey()).toBe(`raydium-clmm:${LINKED}`);
    expect(rows().map((row) => row.getAttribute("data-position-key")).sort()).toEqual([`raydium-clmm:${FIRST}`, `raydium-clmm:${LINKED}`].sort());
  });

  it("a failing (500) Meteora positions read leaves the Raydium list in place and only adds its plain error", async () => {
    state.dex = "500";
    await renderLinked();
    expect(selectedKey()).toBe(`raydium-clmm:${LINKED}`);
    expect(rows().map((row) => row.getAttribute("data-position-key")).sort()).toEqual([`raydium-clmm:${FIRST}`, `raydium-clmm:${LINKED}`].sort());
    expect(container.textContent).toContain("Meteora is down");
  });
});
