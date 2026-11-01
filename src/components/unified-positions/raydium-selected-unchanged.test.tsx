// @vitest-environment happy-dom
// The Raydium selected state on /app is unchanged by the registry DEXes (PR5): a `?position=raydium-clmm:<mint>` deep link
// selects that Raydium position, and the rendered panel matches the snapshot recorded on the PR4 tree (830ce5b, before
// PR5). Where the dex route is on but the deployment does not serve a DEX (404), the page is the same markup.
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
const state = vi.hoisted(() => ({ routeOn: false, dexCalls: 0 }));

vi.mock("@/lib/protocol-flags", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/protocol-flags")>(),
  isDexTxRouteEnabled: () => state.routeOn }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
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
  state.routeOn = false; state.dexCalls = 0;
  window.history.replaceState(null, "", "/app");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/wallet") {
      return Response.json({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: [raydiumRow(FIRST, -20, 20), raydiumRow(LINKED, -10, 10)], assets: [] });
    }
    if (url.pathname.startsWith("/api/dex/")) { state.dexCalls += 1; return new Response(null, { status: 404 }); }
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
const select = () => container.querySelector<HTMLSelectElement>("select#position")!;

describe("/app Raydium selected state (unchanged by the registry DEXes)", () => {
  it("?position=raydium-clmm:<mint> selects that Raydium position, and the panel matches the pre-PR5 snapshot", async () => {
    const html = await renderLinked();
    expect(select().value).toBe(`raydium-clmm:${LINKED}`);
    expect([...select().querySelectorAll("option")].map((option) => option.textContent).join("\n")).not.toMatch(/Raydium|Meteora/);
    expect(html).toMatchSnapshot();
  });

  it("with the dex route on and the DEX not served (404) the markup is identical to the route-off page", async () => {
    const off = await renderLinked();
    await act(async () => root.unmount());
    container.remove(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    state.routeOn = true;
    const on = await renderLinked();
    expect(on).toBe(off);
  });
});
