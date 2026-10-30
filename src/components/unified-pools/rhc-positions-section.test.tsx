// @vitest-environment happy-dom
// "My positions" Robinhood Chain part: nothing at all until MetaMask is connected, even with saved positions.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rhc-univ4-positions-panel", () => ({ RhcUniv4PositionsPanel: () => createElement("div", { "data-testid": "rhc-positions-panel" }) }));

import { RhcPositionsSection } from "./rhc-positions-section";

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); });

const render = (wallet: { name: string; address: string } | null) => act(async () => {
  root.render(createElement(RhcPositionsSection, { wallet: wallet as never, signingEnabled: false, refreshKey: 0 }));
});

describe("RhcPositionsSection", () => {
  it("renders nothing when MetaMask is not connected", async () => {
    await render(null);
    expect(container.innerHTML).toBe("");
    expect(container.textContent).not.toMatch(/MetaMask|Robinhood/);
  });

  it("still renders nothing without MetaMask when this browser has saved Robinhood Chain positions", async () => {
    localStorage.setItem("sofi:rhc:positions:0xabc", JSON.stringify(["12"]));
    await render(null);
    expect(container.innerHTML).toBe("");
  });

  it("shows the positions once MetaMask is connected", async () => {
    await render({ name: "MetaMask", address: "0x1234567890abcdef1234567890abcdef12345678" });
    expect(container.querySelector("[data-testid=rhc-positions-panel]")).not.toBeNull();
    expect(container.querySelector("[data-testid=rhc-wallet]")?.textContent).toContain("0x1234…5678");
  });
});
