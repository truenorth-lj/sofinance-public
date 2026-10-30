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

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  seen.openRhc = null; seen.deepLink = []; seen.panel.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("PoolsPage (/app/rwa-pairs)", () => {
  it("lists the pools, passes the deep link, and opens a Robinhood Chain pool in a MetaMask dialog with no Solana content", async () => {
    await act(async () => { root.render(createElement(PoolsPage, { flags: { orca: false, meteora: false, meteoraOpen: false, rhc: true }, rhcSigningEnabled: true, deepLinkPool: "0xpool" })); });
    expect(container.querySelector("#pools")).not.toBeNull();
    expect(seen.deepLink.at(-1)).toBe("0xpool");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    await act(async () => { seen.openRhc!({ pool: { poolId: "0xpool" } }); });
    const dialog = container.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Open position · Robinhood Chain");
    expect(dialog.textContent).not.toMatch(/Solana|Phantom|Raydium/);
    expect(seen.panel).toHaveBeenLastCalledWith(expect.objectContaining({ autoConnect: true, showPositions: false, signingEnabled: true }));
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Close']")!.click(); });
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });
});
