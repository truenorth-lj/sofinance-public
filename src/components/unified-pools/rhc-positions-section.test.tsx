// @vitest-environment happy-dom
// "My positions" Robinhood Chain part: a quiet one-line hint unless MetaMask is connected or a position is saved here.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rhc-univ4-open-panel", () => ({ connectRhcWallet: vi.fn() }));
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
  root.render(createElement(RhcPositionsSection, { wallet: wallet as never, onConnected: () => {}, signingEnabled: false, refreshKey: 0 }));
});

describe("RhcPositionsSection", () => {
  it("shows only one subtle line when MetaMask is not connected and nothing is saved", async () => {
    await render(null);
    expect(container.querySelector("[data-testid=rhc-positions-hint]")?.textContent).toBe("Robinhood Chain positions → connect MetaMask");
    expect(container.querySelector("[data-testid=rhc-positions-section]")).toBeNull();
  });

  it("shows the Robinhood Chain section when this browser has a saved position", async () => {
    localStorage.setItem("sofi:rhc:positions:0xabc", JSON.stringify(["12"]));
    await render(null);
    expect(container.querySelector("[data-testid=rhc-positions-section]")).not.toBeNull();
    expect(container.querySelector("[data-testid=rhc-positions-hint]")).toBeNull();
  });

  it("ignores an empty or broken saved list", async () => {
    localStorage.setItem("sofi:rhc:positions:0xabc", "[]");
    localStorage.setItem("sofi:rhc:positions:0xdef", "{oops");
    await render(null);
    expect(container.querySelector("[data-testid=rhc-positions-hint]")).not.toBeNull();
  });

  it("shows the positions when MetaMask is connected", async () => {
    await render({ name: "MetaMask", address: "0x1234567890abcdef1234567890abcdef12345678" });
    expect(container.querySelector("[data-testid=rhc-positions-panel]")).not.toBeNull();
    expect(container.querySelector("[data-testid=rhc-wallet]")?.textContent).toContain("0x1234…5678");
  });
});
