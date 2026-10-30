// @vitest-environment happy-dom
// /app (Positions): My positions and the Solana position tools only; no pool list. The Robinhood Chain part of
// My positions shows only while MetaMask shares an account with the site (never from saved positions alone).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ restore: vi.fn<() => Promise<unknown>>(), panel: vi.fn() }));
vi.mock("../selected-app", () => ({
  SelectedApp: (props: Record<string, unknown>) => createElement("div", { "data-testid": "selected-app",
    "data-props": Object.keys(props).sort().join(","), "data-has-rhc": String(Boolean(props.extraPositions)) }),
}));
vi.mock("./unified-pools-panel", () => ({ UnifiedPoolsPanel: () => { seen.panel(); return null; } }));
vi.mock("./rhc-positions-section", () => ({ RhcPositionsSection: () => null }));
vi.mock("../rhc-univ4-open-panel", () => ({ restoreRhcWallet: () => seen.restore() }));

import { UnifiedApp } from "./unified-app";

const FLAGS = { orca: false, meteora: false, meteoraOpen: false, rhc: true };
let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  seen.restore.mockReset(); seen.panel.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

const app = () => container.querySelector("[data-testid=selected-app]")!;
async function render(flags = FLAGS) {
  await act(async () => { root.render(createElement(UnifiedApp, { selected: {}, flags, rhcSigningEnabled: false })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("UnifiedApp (/app)", () => {
  it("renders only My positions and the position tools: no pool list, no Robinhood Chain dialog", async () => {
    seen.restore.mockResolvedValue(null);
    await render();
    expect(seen.panel).not.toHaveBeenCalled();
    expect(app().getAttribute("data-props")).not.toMatch(/poolsSection|solanaToolsHidden/);
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("shows no Robinhood Chain section without MetaMask, even with saved Robinhood Chain positions", async () => {
    localStorage.setItem("sofi:rhc:positions:0xabc", JSON.stringify(["12"]));
    seen.restore.mockResolvedValue(null);
    await render();
    expect(app().getAttribute("data-has-rhc")).toBe("false");
  });

  it("adds the Robinhood Chain positions when MetaMask already shares an account with the site", async () => {
    seen.restore.mockResolvedValue({ name: "MetaMask", address: "0x1234567890abcdef1234567890abcdef12345678", provider: {} });
    await render();
    expect(app().getAttribute("data-has-rhc")).toBe("true");
  });

  it("never asks MetaMask when Robinhood Chain is off", async () => {
    await render({ ...FLAGS, rhc: false });
    expect(seen.restore).not.toHaveBeenCalled();
    expect(app().getAttribute("data-has-rhc")).toBe("false");
  });
});
