// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TermsGate } from "./terms-gate";
import { useWalletConnection, WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { TERMS_STORAGE_KEY } from "@/lib/terms-acceptance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setup(connected = false) {
  const inner: WalletConnection = {
    connected, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1, connectionError: "",
    signTransaction: vi.fn(),
  };
  let gated: WalletConnection | undefined;
  function Reader() { gated = useWalletConnection(); return null; }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const tree = (children: ReactNode) => createElement(WalletConnectionContext.Provider, { value: inner }, createElement(TermsGate, null, children));
  act(() => root.render(tree(createElement(Reader))));
  return { inner, gated: () => gated!, host, root };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => { document.body.innerHTML = ""; });

describe("TermsGate", () => {
  it("requires the checkbox before the first wallet connect, then persists acceptance", () => {
    const { inner, gated, host } = setup();
    act(() => gated().connect());
    expect(inner.connect).not.toHaveBeenCalled();
    const dialog = host.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("I have read and agree to the Terms of Service");
    expect(dialog.textContent).not.toMatch(/resident|region|United States|Taiwan/i);
    expect(dialog.querySelector("a")!.getAttribute("href")).toBe("/terms");
    const [, accept] = Array.from(dialog.querySelectorAll("button"));
    expect(accept!.disabled).toBe(true);
    act(() => { (dialog.querySelector("input[type=checkbox]") as HTMLInputElement).click(); });
    act(() => { accept!.click(); });
    expect(inner.connect).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(TERMS_STORAGE_KEY)).toContain("acceptedAt");
    expect(host.querySelector("[role=dialog]")).toBeNull();
    act(() => gated().connect());
    expect(inner.connect).toHaveBeenCalledTimes(2);
  });

  it("asks an auto-reconnected wallet that never accepted, and can disconnect it", () => {
    const { inner, host } = setup(true);
    const dialog = host.querySelector("[role=dialog]")!;
    expect(dialog).not.toBeNull();
    act(() => { (dialog.querySelectorAll("button")[0] as HTMLButtonElement).click(); });
    expect(inner.disconnect).toHaveBeenCalled();
  });

  it("is mounted inside both wallet providers, so every connect (app, /app/sign deep links, /app/ai MCP card) goes through it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/providers.tsx", "utf8");
    expect(source).toContain("<MobileWalletProvider><TermsGate>{children}</TermsGate></MobileWalletProvider>");
    expect(source).toContain("<BrowserWalletProvider><TermsGate>{children}</TermsGate></BrowserWalletProvider>");
  });
});
