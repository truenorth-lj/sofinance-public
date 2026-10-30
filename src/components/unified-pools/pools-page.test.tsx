// @vitest-environment happy-dom
// /app/rwa-pairs (pools page): the unified pool list, and the Robinhood Chain open dialog (MetaMask) over it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ openRhc: null as null | ((r: { pool: unknown }) => void), deepLink: [] as (string | undefined)[],
  panel: vi.fn<(props: Record<string, unknown>) => void>() }));
vi.mock("../ink", () => ({
  InkShell: ({ children }: { children: unknown }) => createElement("main", null, children as never),
  InkNav: () => null,
  InkHero: ({ title }: { title: string }) => createElement("h1", null, title),
}));
vi.mock("../wallet-connection", () => ({ useWalletConnection: () => ({ address: null, connected: false, connect: vi.fn(), disconnect: vi.fn() }) }));
vi.mock("./unified-pools-panel", () => ({
  UnifiedPoolsPanel: (props: { onOpenRhc: (r: { pool: unknown }) => void; deepLinkPool?: string }) => {
    seen.openRhc = props.onOpenRhc; seen.deepLink.push(props.deepLinkPool); return createElement("section", { id: "pools" });
  },
}));
vi.mock("../rhc-univ4-open-panel", () => ({ RhcUniv4OpenPanel: (props: Record<string, unknown>) => {
  seen.panel(props);
  return createElement("div", { "data-testid": "rhc-open-panel" });
} }));

import { PoolsPage } from "./pools-page";
import { EvmWalletProvider } from "../evm-wallet-connection";
import { createEvmSession } from "@/lib/rhc-wallet/evm-session";

const USER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";
const evmProvider = { request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1237" : method.startsWith("eth_") ? [USER] : null) };
const discover = async () => [{ info: { uuid: "mm", name: "MetaMask", rdns: "io.metamask" }, provider: evmProvider }];

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  seen.openRhc = null; seen.deepLink = []; seen.panel.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("PoolsPage (/app/rwa-pairs)", () => {
  it("lists the pools, passes the deep link, and opens a Robinhood Chain pool in a MetaMask dialog with no Solana content", async () => {
    await act(async () => { root.render(createElement(EvmWalletProvider, { enabled: false, session: createEvmSession({ discover }) },
      createElement(PoolsPage, { flags: { orca: false, meteora: false, meteoraOpen: false, rhc: true }, rhcSigningEnabled: true, deepLinkPool: "0xpool" }))); });
    expect(container.querySelector("#pools")).not.toBeNull();
    expect(seen.deepLink.at(-1)).toBe("0xpool");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    await act(async () => { seen.openRhc!({ pool: { poolId: "0xpool" } }); });
    const dialog = container.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Open position · Robinhood Chain");
    expect(dialog.textContent).not.toMatch(/Solana|Phantom|Raydium/);
    expect(seen.panel).toHaveBeenLastCalledWith(expect.objectContaining({ autoConnect: true, showPositions: false, signingEnabled: true, initialWallet: null }));
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Close']")!.click(); });
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("the dialog connects the shared EVM session and reuses it on the next open (no second prompt)", async () => {
    const session = createEvmSession({ discover });
    await act(async () => { root.render(createElement(EvmWalletProvider, { enabled: false, session },
      createElement(PoolsPage, { flags: { orca: false, meteora: false, meteoraOpen: false, rhc: true }, rhcSigningEnabled: true }))); });
    await act(async () => { seen.openRhc!({ pool: { poolId: "0xpool" } }); });
    const first = seen.panel.mock.lastCall![0] as { connectWallet: () => Promise<unknown> };
    await act(async () => { await first.connectWallet(); });
    expect(session.getState().wallet?.address).toBe(USER);
    expect(seen.panel).toHaveBeenLastCalledWith(expect.objectContaining({ initialWallet: session.getState().wallet, autoConnect: false }));
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Close']")!.click(); });
    await act(async () => { seen.openRhc!({ pool: { poolId: "0xpool" } }); });
    expect(seen.panel).toHaveBeenLastCalledWith(expect.objectContaining({ initialWallet: session.getState().wallet, autoConnect: false }));
  });
});
