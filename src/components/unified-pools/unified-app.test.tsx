// @vitest-environment happy-dom
// /app (Positions): My positions and the Solana position tools only; no pool list. The Robinhood Chain part of
// My positions shows only while the nav's EVM wallet is connected (restored when MetaMask already shares an account with
// the site; never from saved positions alone).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ accounts: vi.fn<() => Promise<unknown>>(), panel: vi.fn() }));
vi.mock("../selected-app", () => ({
  SelectedApp: (props: Record<string, unknown>) => createElement("div", { "data-testid": "selected-app",
    "data-props": Object.keys(props).sort().join(","), "data-has-rhc": String(Boolean(props.extraPositions)) }),
}));
vi.mock("./unified-pools-panel", () => ({ UnifiedPoolsPanel: () => { seen.panel(); return null; } }));
vi.mock("./rhc-positions-section", () => ({ RhcPositionsSection: () => null }));

import { UnifiedApp } from "./unified-app";
import { EvmWalletProvider } from "../evm-wallet-connection";
import { createEvmSession } from "@/lib/rhc-wallet/evm-session";

const provider = { request: async ({ method }: { method: string }) => (method === "eth_accounts" ? seen.accounts() : method === "eth_chainId" ? "0x1237" : null) };
const discover = vi.fn(async () => [{ info: { uuid: "mm", name: "MetaMask", rdns: "io.metamask" }, provider }]);

const FLAGS = { orca: false, meteora: false, meteoraOpen: false, rhc: true };
let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  seen.accounts.mockReset(); seen.panel.mockReset(); discover.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

const app = () => container.querySelector("[data-testid=selected-app]")!;
async function render(flags = FLAGS, evmEnabled = true) {
  const session = createEvmSession({ discover });
  await act(async () => { root.render(createElement(EvmWalletProvider, { enabled: evmEnabled, session },
    createElement(UnifiedApp, { selected: {}, flags, rhcSigningEnabled: false }))); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("UnifiedApp (/app)", () => {
  it("renders only My positions and the position tools: no pool list, no Robinhood Chain dialog", async () => {
    seen.accounts.mockResolvedValue([]);
    await render();
    expect(seen.panel).not.toHaveBeenCalled();
    expect(app().getAttribute("data-props")).not.toMatch(/poolsSection|solanaToolsHidden/);
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("shows no Robinhood Chain section without MetaMask, even with saved Robinhood Chain positions", async () => {
    localStorage.setItem("sofi:rhc:positions:0xabc", JSON.stringify(["12"]));
    seen.accounts.mockResolvedValue([]);
    await render();
    expect(app().getAttribute("data-has-rhc")).toBe("false");
  });

  it("adds the Robinhood Chain positions when MetaMask already shares an account with the site", async () => {
    seen.accounts.mockResolvedValue(["0x1234567890abcdef1234567890abcdef12345678"]);
    await render();
    expect(app().getAttribute("data-has-rhc")).toBe("true");
  });

  it("never shows Robinhood Chain positions when Robinhood Chain is off, even with a shared account", async () => {
    seen.accounts.mockResolvedValue(["0x1234567890abcdef1234567890abcdef12345678"]);
    await render({ ...FLAGS, rhc: false });
    expect(app().getAttribute("data-has-rhc")).toBe("false");
  });

  it("never asks the EVM wallet when Robinhood Chain trading is off", async () => {
    await render(FLAGS, false);
    expect(discover).not.toHaveBeenCalled();
    expect(seen.accounts).not.toHaveBeenCalled();
    expect(app().getAttribute("data-has-rhc")).toBe("false");
  });
});
