// @vitest-environment happy-dom
// /app "Rescan wallet": one click rescans the Solana wallet (unchanged) and, while the nav's EVM wallet is connected, the
// Robinhood Chain positions too (fresh server scan). The first load keeps the cached Robinhood Chain scan.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USDC_MINT } from "@sofinance/engine/ids";
import { UnifiedApp } from "./unified-app";
import { EvmWalletProvider } from "../evm-wallet-connection";
import { createEvmSession } from "@/lib/rhc-wallet/evm-session";

const SOL_WALLET = "EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb";
const EVM_WALLET = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";
const state = vi.hoisted(() => ({ solWallet: "" }));

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("../use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("../use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("../transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("../wallet-connection", async (importOriginal) => ({ ...await importOriginal<typeof import("../wallet-connection")>(),
  useWalletConnection: () => ({ address: state.solWallet, connected: Boolean(state.solWallet), connect: vi.fn(), disconnect: vi.fn(),
    isMobile: false, walletsCount: 1, connectionError: "", signTransaction: vi.fn() }) }));

const provider = { request: async ({ method }: { method: string }) =>
  (method === "eth_accounts" ? [EVM_WALLET] : method === "eth_chainId" ? "0x1237" : null) };
const discover = vi.fn(async () => [{ info: { uuid: "mm", name: "MetaMask", rdns: "io.metamask" }, provider }]);

let container: HTMLDivElement; let root: Root; let urls: URL[];
const calls = (path: string) => urls.filter((url) => url.pathname === path);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); urls = [];
  state.solWallet = SOL_WALLET;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x"); urls.push(url);
    if (url.pathname === "/api/wallet") return Response.json({ wallet: SOL_WALLET, slot: 1, fetchedAt: 1, positions: [],
      assets: [{ kind: "token", mint: USDC_MINT, tokenProgram: null, decimals: 6, balance: "1", totalBalance: "1", account: "a", eligible: true, reason: null }] });
    if (url.pathname === "/api/rhc-univ4-positions") return Response.json({ state: "scan", positions: [] });
    return Response.json({});
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
async function render(rhc = true) {
  const session = createEvmSession({ discover });
  await act(async () => { root.render(createElement(EvmWalletProvider, { enabled: true, session },
    createElement(UnifiedApp, { selected: {}, flags: { orca: false, meteora: false, meteoraOpen: false, rhc }, rhcSigningEnabled: false }))); });
  await settle();
}
const rescanButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Rescan wallet")!;
async function clickRescan() { await act(async () => { rescanButton().click(); }); await settle(); }

describe("/app Rescan wallet", () => {
  it("first load: one Solana scan and one cached (not fresh) Robinhood Chain scan", async () => {
    await render();
    expect(calls("/api/wallet")).toHaveLength(1);
    const scans = calls("/api/rhc-univ4-positions");
    expect(scans).toHaveLength(1);
    expect(scans[0]!.searchParams.get("wallet")).toBe(EVM_WALLET);
    expect(scans[0]!.searchParams.get("fresh")).toBeNull();
  });

  it("each click rescans the Solana wallet and runs a fresh Robinhood Chain scan", async () => {
    await render();
    await clickRescan();
    expect(calls("/api/wallet")).toHaveLength(2);
    expect(calls("/api/rhc-univ4-positions").map((url) => url.searchParams.get("fresh"))).toEqual([null, "1"]);
    await clickRescan();
    expect(calls("/api/wallet")).toHaveLength(3);
    expect(calls("/api/rhc-univ4-positions").map((url) => url.searchParams.get("fresh"))).toEqual([null, "1", "1"]);
  });

  it("shows the Robinhood Chain scanning status while the fresh scan runs", async () => {
    await render();
    let finish!: () => void;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), "http://x"); urls.push(url);
      if (url.pathname === "/api/rhc-univ4-positions") await new Promise<void>((resolve) => { finish = resolve; });
      return Response.json(url.pathname === "/api/rhc-univ4-positions" ? { state: "scan", positions: [] }
        : { wallet: SOL_WALLET, slot: 1, fetchedAt: 1, positions: [], assets: [] });
    });
    await clickRescan();
    expect(container.querySelector("[data-testid=positions-scanning]")).not.toBeNull();
    await act(async () => { finish(); }); await settle();
    expect(container.querySelector("[data-testid=positions-scanning]")).toBeNull();
    expect(container.querySelector("[data-testid=positions-empty]")).not.toBeNull();
  });

  it("Robinhood Chain off: the button only rescans Solana, as before", async () => {
    await render(false);
    await clickRescan();
    expect(calls("/api/wallet")).toHaveLength(2);
    expect(calls("/api/rhc-univ4-positions")).toHaveLength(0);
  });

  it("only the EVM wallet connected: the button rescans Robinhood Chain without a Solana scan", async () => {
    state.solWallet = "";
    await render();
    expect(rescanButton().disabled).toBe(false);
    await clickRescan();
    expect(calls("/api/wallet")).toHaveLength(0);
    expect(calls("/api/rhc-univ4-positions").map((url) => url.searchParams.get("fresh"))).toEqual([null, "1"]);
  });

  it("no wallet at all: the button stays disabled, as before", async () => {
    state.solWallet = "";
    await render(false);
    expect(rescanButton().disabled).toBe(true);
  });
});
