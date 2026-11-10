// @vitest-environment happy-dom
// /app All positions: lightweight chain rows plus stock drilldown; tools come from the selected position's
// capabilities (no chain checks in the UI). Robinhood Chain: only Withdraw (the full Close); the other tabs are greyed but
// clickable and say why inline. URL state: ?position=<key>&view=<tool>.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { UnifiedApp } from "./unified-app";
import { EvmWalletProvider } from "../evm-wallet-connection";
import { createEvmSession } from "@/lib/rhc-wallet/evm-session";
import { SOLANA_CONNECT_EMPTY_OPTION } from "@/lib/unified-positions/rows";

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
    createElement(UnifiedApp, { selected, flags: { orca: false, meteora: false, meteoraOpen: false, rhc: true }, rhcSigningEnabled: false }))); });
  await settle();
}
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="position-fallback-select"]')];
const selectedKey = () => rows().find((row) => row.getAttribute("aria-pressed") === "true")?.getAttribute("data-position-key");
const groups = () => [...container.querySelectorAll('[data-testid="position-chain-group"]')].map((group) => [group.getAttribute("aria-label"),
  group.querySelector("button") ? [...group.querySelectorAll("button")].map((row) => row.firstChild?.textContent) : [...group.querySelectorAll("p")].map((row) => row.textContent)]);
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("nav[aria-label='Position operations'] button")].find((b) => b.textContent === label)!;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };
async function choose(value: string) {
  await act(async () => rows().find((row) => row.getAttribute("data-position-key") === value)!.click());
  await settle();
}

describe("/app unified All positions", () => {
  it("keeps unsupported RHC positions selectable inside Performance without a history overview", async () => {
    await render();
    await click(tab("Performance"));
    expect(container.querySelector('[data-testid="stocks-overview"]')).toBeNull();
    expect(rows()).toHaveLength(3);
    const entry = container.querySelector('[aria-labelledby="all-positions-heading"]')!;
    expect(entry.querySelector('[aria-label="Position NFT number"]')).not.toBeNull();
    await choose("rhc-uniswap-v4:7");
    expect(selectedKey()).toBe("rhc-uniswap-v4:7");
    expect(container.querySelector('[data-testid="tool-unavailable"]')).not.toBeNull();
    expect(new URL(window.location.href).searchParams.get("position")).toBe("rhc-uniswap-v4:7");
  });
  it("EVM wallet only: Solana group says connect, Robinhood Chain group with Closed last, first position selected on its Withdraw", async () => {
    await render();
    expect(groups()).toEqual([["Solana", [SOLANA_CONNECT_EMPTY_OPTION]], ["Robinhood Chain", [
      expect.stringMatching(/^#9 · .+ · range 0\.98778–1\.0077 SPCXon per SPCX$/),
      "#7 · ticks -123 to 77",
      expect.stringMatching(/^#8 · .+ · Closed$/)]]]);
    expect(selectedKey()).toBe("rhc-uniswap-v4:9");
    expect(tab("Withdraw").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-testid=rhc-withdraw]")?.getAttribute("data-position")).toBe("9");
    expect(container.querySelector("[data-testid=rhc-range]")!.textContent).toBe("Range 0.98778–1.0077 SPCXon per SPCX");
    // No separate Robinhood Chain block with its own list any more; the Add-by-number field stays in the RHC status area.
    expect(container.querySelector("[data-testid=rhc-positions-panel]")).toBeNull();
    expect(container.querySelector("[aria-label='Position NFT number']")).not.toBeNull();
  });

  it("greyed tabs stay clickable and say 'Not available for this pool yet' inline; the URL tracks position and view", async () => {
    await render();
    for (const label of ["Compound fees", "Performance", "Add to position"]) expect(tab(label).getAttribute("data-unavailable")).toBe("true");
    expect(tab("Withdraw").getAttribute("data-unavailable")).toBeNull();
    await click(tab("Compound fees"));
    expect(tab("Compound fees").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-testid=tool-unavailable]")!.textContent).toBe("Not available for this pool yet");
    expect(container.querySelector("[data-testid=rhc-withdraw]")).toBeNull();
    const url = new URL(window.location.href);
    expect([url.searchParams.get("position"), url.searchParams.get("view")]).toEqual(["rhc-uniswap-v4:9", "compound"]);
  });

  it("per-position capabilities: a position in an unlisted pool keeps the same tabs, only Withdraw is greyed with its reason", async () => {
    await render();
    const before = [...container.querySelectorAll("nav[aria-label='Position operations'] button")].map((b) => b.textContent);
    await choose("rhc-uniswap-v4:7");
    expect([...container.querySelectorAll("nav[aria-label='Position operations'] button")].map((b) => b.textContent)).toEqual(before);
    expect(tab("Withdraw").getAttribute("data-unavailable")).toBe("true");
    expect(container.querySelector("[data-testid=tool-unavailable]")!.textContent).toBe("StablePair pool that SoFinance does not list yet: view only.");
    expect(new URL(window.location.href).searchParams.get("position")).toBe("rhc-uniswap-v4:7");
  });

  it("?position= opens that Robinhood Chain position; ?view=compound lands on its first available tool", async () => {
    await render({ initialPositionKey: "rhc-uniswap-v4:8", initialView: "compound" });
    expect(selectedKey()).toBe("rhc-uniswap-v4:8");
    expect(tab("Withdraw").getAttribute("aria-pressed")).toBe("true");
  });

  it("Learn more details shows the ticks behind the price range", async () => {
    await render();
    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Learn more"))!);
    expect(document.body.querySelector("[data-testid=rhc-ticks]")!.textContent).toContain("Ticks -123 to 77 (price 0.98778–1.0077 SPCXon per SPCX)");
  });

  it("Solana + EVM wallets: Solana group first (empty row when none), then Robinhood Chain; no source names with one source", async () => {
    state.solWallet = SOL_WALLET;
    await render();
    expect(groups().map(([label]) => label)).toEqual(["Solana", "Robinhood Chain"]);
    expect(groups()[0]![1]).toEqual(["No positions found"]);
    expect((groups()[1]![1] as string[]).every((label) => !label.startsWith("Uniswap v4"))).toBe(true);
    expect(selectedKey()).toBe("rhc-uniswap-v4:9");
  });

  it("empty Robinhood Chain wallet: the group stays with a disabled 'No positions found' row and the open-a-position link", async () => {
    state.solWallet = SOL_WALLET; state.scan = [];
    await render({ initialView: "deposit" });
    expect(groups()).toEqual([["Solana", ["No positions found"]], ["Robinhood Chain", ["No positions found"]]]);
    expect(rows()).toHaveLength(0);
    expect(container.querySelector("[data-testid=positions-empty]")).not.toBeNull();
  });
});

describe("/app Closed positions", () => {
  it("a liquidity-0 Robinhood Chain position shows the shared Closed badge when selected", async () => {
    await render({ initialPositionKey: "rhc-uniswap-v4:8" });
    expect(container.querySelector("[data-testid=position-closed]")!.textContent).toBe("Closed: no liquidity left");
    await choose("rhc-uniswap-v4:9");
    expect(container.querySelector("[data-testid=position-closed]")).toBeNull();
  });
});

describe("/app shared detail panel for a Robinhood Chain position (PM review of #270)", () => {
  it("no Solana connect prompt inside the panel while a Robinhood Chain position is selected; it is the Solana group's empty row", async () => {
    await render();
    expect(selectedKey()).toBe("rhc-uniswap-v4:9");
    expect(container.textContent).not.toContain("Connect your Solana wallet to find your Solana liquidity positions");
    const solana = container.querySelector('[data-testid="position-chain-group"][aria-label="Solana"]')!;
    expect(solana.querySelector("p")?.textContent).toBe(SOLANA_CONNECT_EMPTY_OPTION);
    expect(solana.querySelector("button")).toBeNull();
  });

  it("with nothing selected (no Robinhood Chain positions) the Solana connect prompt still shows", async () => {
    state.scan = [];
    await render();
    expect(container.textContent).toContain("Connect your Solana wallet to find your Solana liquidity positions");
  });

  it("Liquidity and Unclaimed fees rows in Solana's format with amounts and USD when the read and indexer have them", async () => {
    state.values = [{ tokenId: "9", poolId: POOL.poolId, amount0: "166993982055046672578", amount1: "171866848980666712441",
      fees0: "28588329131852", fees1: "7703474624138", priceUsd0: 2, priceUsd1: null }];
    await render();
    // One read for the allowlisted positions only (#7 is in an unlisted pool).
    expect(state.valueCalls).toEqual(["8,9"]);
    const assets = container.querySelector("[data-testid=rhc-position-assets]")!;
    // label | amount + symbol | USD: one value per cell.
    const rows = [...assets.querySelectorAll("dl")].map((dl) => [...dl.querySelectorAll("dt")].map((dt) =>
      [dt.textContent, dt.nextElementSibling!.textContent, dt.nextElementSibling!.nextElementSibling!.textContent]));
    expect(rows).toEqual([
      [["Liquidity", `166.993982 ${POOL.currency0.symbol}`, "$333.99"], ["Unclaimed fees", `0.000028 ${POOL.currency0.symbol}`, "$0.00"]],
      [["Liquidity", `171.866848 ${POOL.currency1.symbol}`, "—"], ["Unclaimed fees", `0.000007 ${POOL.currency1.symbol}`, "—"]],
    ]);
  });

  it("a field it cannot read shows a dash and keeps the row (values read failed)", async () => {
    await render();
    const assets = container.querySelector("[data-testid=rhc-position-assets]")!;
    expect([...assets.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Liquidity", "Unclaimed fees", "Liquidity", "Unclaimed fees"]);
    expect([...assets.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual([
      `— ${POOL.currency0.symbol}`, "—", `— ${POOL.currency0.symbol}`, "—", `— ${POOL.currency1.symbol}`, "—", `— ${POOL.currency1.symbol}`, "—"]);
  });

  it("a position outside the allowlist keeps both token rows, all dashes", async () => {
    state.values = [];
    await render({ initialPositionKey: "rhc-uniswap-v4:7" });
    const assets = container.querySelector("[data-testid=rhc-position-assets]")!;
    expect([...assets.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["— Token 0", "—", "— Token 0", "—", "— Token 1", "—", "— Token 1", "—"]);
  });
});
