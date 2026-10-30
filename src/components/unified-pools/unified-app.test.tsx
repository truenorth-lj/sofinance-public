// @vitest-environment happy-dom
// /app: while the Robinhood Chain open dialog is up, the Solana (Raydium) position tools behind it are hidden.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ hidden: [] as boolean[], openRhc: null as null | ((r: { pool: unknown }) => void),
  walletChange: null as null | ((w: unknown) => void) }));
vi.mock("../selected-app", () => ({
  SelectedApp: (props: { solanaToolsHidden?: boolean; poolsSection?: unknown; extraPositions?: unknown }) => {
    seen.hidden.push(Boolean(props.solanaToolsHidden));
    return createElement("div", { "data-testid": "selected-app", "data-tools-hidden": String(Boolean(props.solanaToolsHidden)),
      "data-has-rhc": String(Boolean(props.extraPositions)) }, props.poolsSection as never);
  },
}));
vi.mock("./unified-pools-panel", () => ({
  UnifiedPoolsPanel: (props: { onOpenRhc: (r: { pool: unknown }) => void }) => { seen.openRhc = props.onOpenRhc; return null; },
}));
vi.mock("./rhc-positions-section", () => ({ RhcPositionsSection: () => null }));
vi.mock("../rhc-univ4-open-panel", () => ({ RhcUniv4OpenPanel: (props: { onWalletChange?: (w: unknown) => void }) => {
  seen.walletChange = props.onWalletChange ?? null;
  return createElement("div", { "data-testid": "rhc-open-panel" });
} }));

import { UnifiedApp } from "./unified-app";

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  seen.hidden = []; seen.openRhc = null; seen.walletChange = null;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("UnifiedApp", () => {
  it("hides the Solana position tools only while a Robinhood Chain pool is being opened", async () => {
    await act(async () => { root.render(createElement(UnifiedApp, { selected: {}, flags: { orca: false, meteora: false, meteoraOpen: false, rhc: true }, rhcSigningEnabled: false })); });
    const app = () => container.querySelector("[data-testid=selected-app]")!;
    expect(app().getAttribute("data-tools-hidden")).toBe("false");
    await act(async () => { seen.openRhc!({ pool: { poolId: "0xpool" } }); });
    expect(container.querySelector("[data-testid=rhc-open-panel]")).not.toBeNull();
    expect(app().getAttribute("data-tools-hidden")).toBe("true");
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Close']")!.click(); });
    expect(container.querySelector("[data-testid=rhc-open-panel]")).toBeNull();
    expect(app().getAttribute("data-tools-hidden")).toBe("false");
  });

  it("adds the Robinhood Chain part of My positions only after MetaMask connects from a pool's Open position", async () => {
    localStorage.setItem("sofi:rhc:positions:0xabc", JSON.stringify(["12"]));
    await act(async () => { root.render(createElement(UnifiedApp, { selected: {}, flags: { orca: false, meteora: false, meteoraOpen: false, rhc: true }, rhcSigningEnabled: false })); });
    const app = () => container.querySelector("[data-testid=selected-app]")!;
    expect(app().getAttribute("data-has-rhc")).toBe("false");
    await act(async () => { seen.openRhc!({ pool: { poolId: "0xpool" } }); });
    await act(async () => { seen.walletChange!({ name: "MetaMask", address: "0x1234567890abcdef1234567890abcdef12345678", provider: {} }); });
    expect(app().getAttribute("data-has-rhc")).toBe("true");
    localStorage.clear();
  });
});
