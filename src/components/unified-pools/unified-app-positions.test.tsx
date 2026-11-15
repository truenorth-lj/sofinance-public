// @vitest-environment happy-dom
// /app All positions: lightweight chain rows plus stock drilldown; each row's buttons come from its position's capabilities
// (no chain checks in the UI) and open popups (LJ 11/14). Robinhood Chain: only Close (the full withdraw). Clicking a row
// opens its detail. URL state: ?position=<key> (and view=performance while a detail is open).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { UnifiedApp } from "./unified-app";
import { EvmWalletProvider } from "../evm-wallet-connection";
import { createEvmSession } from "@/lib/rhc-wallet/evm-session";
import { openPopup, openRowDetail } from "../test-support/portfolio-popups";

const SOL_WALLET = "EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb";
const EVM_WALLET = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";
const POOL = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const state = vi.hoisted(() => ({ solWallet: "", scan: [] as unknown[], values: null as unknown[] | null, valueCalls: [] as string[] }));

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
const held = (tokenId: string, liquidity = "1000", poolId: string = POOL.poolId) => ({ tokenId, hooks: null, stablePair: true,
  position: { tokenId, owner: EVM_WALLET, ownedByUser: true, liquidity, tickLower: -123, tickUpper: 77, poolId, baseSymbol: POOL.baseSymbol } });

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  state.solWallet = ""; state.scan = [held("9"), held("8", "0"), held("7", "1000", "0xdead")]; state.values = null; state.valueCalls = [];
  window.history.replaceState(null, "", "/app");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/wallet") return Response.json({ wallet: SOL_WALLET, slot: 1, fetchedAt: 1, positions: [], assets: [] });
    if (url.pathname === "/api/rhc-univ4-positions") return Response.json({ state: "scan", positions: state.scan });
    if (url.pathname === "/api/rhc-univ4-position-values") {
      state.valueCalls.push(url.searchParams.get("ids") ?? "");
      return state.values ? Response.json({ state: "values", values: state.values, checkedAt: 1 }) : Response.json({ error: "down" }, { status: 503 });
    }
    return Response.json({});
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
async function render(selected: Record<string, unknown> = {}) {
  const session = createEvmSession({ discover });
  await act(async () => { root.render(createElement(EvmWalletProvider, { enabled: true, session },
    createElement(UnifiedApp, { selected, flags: { orca: false, meteora: false, rhc: true }, rhcSigningEnabled: false }))); });
  await settle();
}
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="position-fallback-select"]')];
const openDialog = () => container.querySelector('dialog[data-open="true"]');
const actionsOf = (key: string) => [...rows().find((row) => row.getAttribute("data-position-key") === key)!.closest("li")!
  .querySelectorAll<HTMLButtonElement>('[data-testid="position-row-action"]')];
const groups = () => [...container.querySelectorAll('[data-testid="position-chain-group"]')].map((group) => [group.getAttribute("aria-label"),
  [...group.querySelectorAll('[data-testid="position-fallback-select"]')].map((row) => [row.querySelector('[data-testid="position-row-title"]')?.textContent,
    row.querySelector('[data-testid="position-row-subtitle"]')?.textContent, row.querySelector("[data-range-status]")?.textContent ?? ""].join(" · "))]);
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };
async function detail(key: string) { await openRowDetail(container, key); await settle(); }
const closeOpen = async () => { const close = openDialog()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]'); if (close) await click(close); };

describe("/app unified All positions", () => {
  it("lists unsupported RHC positions without a history overview or the manual NFT field; a row click opens its detail", async () => {
    await render();
    expect(container.querySelector('[data-testid="stocks-overview"]')).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(container.querySelector('[aria-label="Position NFT number"]')).toBeNull();
    expect(openDialog()).toBeNull();
    await detail("uniswap-v4-rhc:7");
    expect(openPopup(container, "performance-popup")).not.toBeNull();
    const url = new URL(window.location.href).searchParams;
    expect([url.get("position"), url.get("view")]).toEqual(["uniswap-v4-rhc:7", "performance"]);
  });
  it("EVM wallet only: no empty Solana group, Robinhood Chain group with Closed last; nothing opens by itself", async () => {
    await render();
    expect(groups()).toEqual([["Robinhood Chain", [
      // Portfolio rows: pair, position number, the grey range badge (the list has no RHC range read; Closed has none).
      "SPCX / SPCXon · #9 · Range unknown",
      "Position #7 ·  · Range unknown",
      "SPCX / SPCXon · #8 · "]]]);
    expect(container.querySelector('[data-position-key="uniswap-v4-rhc:8"]')!.textContent).toContain("Closed");
    expect(openDialog()).toBeNull();
    expect(container.querySelector("[data-testid=rhc-positions-panel]")).toBeNull();
    await detail("uniswap-v4-rhc:9");
    expect(openDialog()!.querySelector("[data-testid=rhc-range]")!.textContent).toBe("Range 0.98778–1.0077 SPCXon per SPCX");
  });

  it("an RHC row keeps only Close; it opens the Close popup and the URL tracks the position", async () => {
    await render();
    expect(actionsOf("uniswap-v4-rhc:9").map((b) => b.textContent)).toEqual(["Close"]);
    await click(actionsOf("uniswap-v4-rhc:9")[0]!);
    expect(openPopup(container, "withdraw-popup")?.querySelector("[data-testid=rhc-withdraw]")?.getAttribute("data-position")).toBe("9");
    const url = new URL(window.location.href);
    expect([url.searchParams.get("position"), url.searchParams.get("view")]).toEqual(["uniswap-v4-rhc:9", null]);
  });

  it("per-position capabilities: a position in an unlisted pool has no buttons; its detail says why", async () => {
    await render();
    expect(actionsOf("uniswap-v4-rhc:7")).toEqual([]);
    await detail("uniswap-v4-rhc:7");
    expect(openPopup(container, "performance-popup")!.querySelector("[data-testid=tool-unavailable]")!.textContent).toBe("StablePair pool that SoFinance does not list yet: view only.");
    expect(new URL(window.location.href).searchParams.get("position")).toBe("uniswap-v4-rhc:7");
  });

  it("?position= with ?view=compound lands on Portfolio without opening anything", async () => {
    await render({ initialPositionKey: "uniswap-v4-rhc:8", initialView: "compound" });
    expect(rows()).toHaveLength(3);
    expect(openDialog()).toBeNull();
  });

  it("has no Learn more details; the detail shows the position number and pool, without ticks or the owner", async () => {
    await render();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Learn more"))).toBe(false);
    await detail("uniswap-v4-rhc:9");
    expect(openDialog()!.textContent).toContain("#9");
    expect(document.body.querySelector("[data-testid=rhc-ticks]")).toBeNull();
    expect(document.body.textContent).not.toContain("Ticks -123 to 77");
  });

  it("Solana + EVM wallets: an empty Solana group is hidden, Robinhood Chain shows; no source names with one source", async () => {
    state.solWallet = SOL_WALLET;
    await render();
    expect(groups().map(([label]) => label)).toEqual(["Robinhood Chain"]);
    expect((groups()[0]![1] as string[]).every((label) => !label.startsWith("Uniswap v4"))).toBe(true);
  });

  it("empty Solana and Robinhood Chain wallets: one empty state with the open-a-position link, no empty groups", async () => {
    state.solWallet = SOL_WALLET; state.scan = [];
    await render({ initialView: "deposit" });
    expect(groups()).toEqual([]);
    expect(rows()).toHaveLength(0);
    const empty = container.querySelectorAll("[data-testid=positions-empty-state]");
    expect(empty).toHaveLength(1);
    expect(empty[0]!.textContent).toContain("No positions in this wallet yet.");
    expect(empty[0]!.querySelector("a")?.textContent).toBe("Go to Pools");
    expect(container.textContent).not.toContain("No positions found");
  });
});

describe("/app Closed positions", () => {
  it("a liquidity-0 Robinhood Chain position shows the shared Closed badge in its detail", async () => {
    await render({ initialPositionKey: "uniswap-v4-rhc:8" });
    await detail("uniswap-v4-rhc:8");
    expect(openDialog()!.querySelector("[data-testid=position-closed]")!.textContent).toBe("Closed: no liquidity left");
    await closeOpen(); await detail("uniswap-v4-rhc:9");
    expect(openDialog()!.querySelector("[data-testid=position-closed]")).toBeNull();
  });
});

describe("/app shared detail panel for a Robinhood Chain position (PM review of #270)", () => {
  it("no connect prompt or empty Solana group while Robinhood Chain positions are listed", async () => {
    await render();
    expect(container.querySelector("[data-testid=positions-empty-state]")).toBeNull();
    expect(container.querySelector('[data-testid="position-chain-group"][aria-label="Solana"]')).toBeNull();
  });

  it("with nothing selected (no Robinhood Chain positions) the one empty state asks to connect", async () => {
    state.scan = [];
    await render();
    expect(container.querySelectorAll("[data-testid=positions-empty-state]")).toHaveLength(1);
    expect(container.textContent).toContain("Connect your wallet to see your positions.");
  });

  it("Liquidity and Unclaimed fees rows in Solana's format with amounts and USD when the read and indexer have them", async () => {
    state.values = [{ tokenId: "9", poolId: POOL.poolId, amount0: "166993982055046672578", amount1: "171866848980666712441",
      fees0: "28588329131852", fees1: "7703474624138", priceUsd0: 2, priceUsd1: null }];
    await render();
    // One read for the allowlisted positions only (#7 is in an unlisted pool).
    expect(state.valueCalls).toEqual(["8,9"]);
    await detail("uniswap-v4-rhc:9");
    const assets = container.querySelector("[data-testid=rhc-position-assets]")!;
    // label | amount + symbol | USD: one value per cell.
    const rows = [...assets.querySelectorAll("dl")].map((dl) => [...dl.querySelectorAll("dt")].map((dt) =>
      [dt.textContent, dt.nextElementSibling!.textContent, dt.nextElementSibling!.nextElementSibling!.textContent]));
    expect(rows).toEqual([
      [["Liquidity", `166.993982 ${POOL.currency0.symbol}`, "$333.99"], ["Unclaimed fees", `0.000028 ${POOL.currency0.symbol}`, "$0.00"]],
      [["Liquidity", `171.866848 ${POOL.currency1.symbol}`, "—"], ["Unclaimed fees", `0.000007 ${POOL.currency1.symbol}`, "—"]],
    ]);
  });

  it("the Robinhood Chain detail shows the range pill and token rows but no second range badge (the row has it, LJ 11/14)", async () => {
    await render(); await detail("uniswap-v4-rhc:9");
    const header = container.querySelector("[data-testid=rhc-position-header]")!;
    expect(header.querySelector("[data-testid=rhc-range]")).not.toBeNull();
    expect(header.querySelector("[data-testid=range-badge]")).toBeNull();
    expect(header.querySelector("[data-testid=rhc-position-assets]")).not.toBeNull();
    expect(container.querySelector("[data-testid=rhc-wrong-network]")).toBeNull();
  });

  it("a field it cannot read shows a dash and keeps the row (values read failed)", async () => {
    await render(); await detail("uniswap-v4-rhc:9");
    const assets = container.querySelector("[data-testid=rhc-position-assets]")!;
    expect([...assets.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Liquidity", "Unclaimed fees", "Liquidity", "Unclaimed fees"]);
    expect([...assets.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual([
      `— ${POOL.currency0.symbol}`, "—", `— ${POOL.currency0.symbol}`, "—", `— ${POOL.currency1.symbol}`, "—", `— ${POOL.currency1.symbol}`, "—"]);
  });

  it("a position outside the allowlist keeps both token rows, all dashes", async () => {
    state.values = [];
    await render({ initialPositionKey: "uniswap-v4-rhc:7" }); await detail("uniswap-v4-rhc:7");
    const assets = container.querySelector("[data-testid=rhc-position-assets]")!;
    expect([...assets.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["— Token 0", "—", "— Token 0", "—", "— Token 1", "—", "— Token 1", "—"]);
  });

  it("a leftover rhc-uniswap-v4:<id> URL no longer selects the canonical row", async () => {
    await render({ initialPositionKey: "rhc-uniswap-v4:8", initialView: "performance" });
    expect(openDialog()).toBeNull();
    expect(new URL(window.location.href).searchParams.get("position")).toBeNull();
  });

  it("makes exactly one positions scan network call per page load for an EVM wallet (dedicated route only)", async () => {
    await render();
    const paths = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), "http://x").pathname);
    expect(paths.filter((path) => path === "/api/rhc-univ4-positions")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/dex/uniswap-v4-rhc/positions")).toHaveLength(0);
    expect(rows()).toHaveLength(3);
  });

});
