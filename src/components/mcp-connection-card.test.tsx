import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { McpConnectionCard } from "./mcp-connection-card";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";

const wallet = "11111111111111111111111111111111";

function connection(overrides: Partial<WalletConnection> = {}): WalletConnection {
  return {
    connected: true,
    connect: () => undefined,
    disconnect: () => undefined,
    isMobile: false,
    walletsCount: 1,
    connectionError: "",
    signTransaction: async (transaction) => transaction,
    signMessage: async () => new Uint8Array(64),
    ...overrides,
  };
}

function render(overrides: Partial<WalletConnection> = {}) {
  const signMessage = overrides.signMessage ?? vi.fn(async () => new Uint8Array(64));
  const value = connection({ ...overrides, signMessage });
  const markup = renderToStaticMarkup(
    createElement(
      WalletConnectionContext.Provider,
      { value },
      createElement(McpConnectionCard, { wallet }) as ReactNode,
    ),
  );
  return { markup, signMessage };
}

describe("McpConnectionCard", () => {
  it("shows an explicit sign button and does not prompt the wallet on render", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { markup, signMessage } = render();

    expect(markup).toContain("Sign to get MCP config");
    expect(markup).toContain("WalletConnect connects the session");
    expect(markup).not.toContain("Please sign the message in your wallet");
    expect(markup).not.toContain("Generating MCP connection token");
    expect(markup).not.toContain("Option A: Direct HTTP");
    expect(markup).not.toContain("Option B: Zero-Secret Shim");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
