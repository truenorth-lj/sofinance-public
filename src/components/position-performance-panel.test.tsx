import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PositionPerformancePanel } from "./position-performance-panel";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";

const connectedWallet = "11111111111111111111111111111111";
const urlWallet = "22222222222222222222222222222222";
const urlMint = "33333333333333333333333333333333";

function connection(overrides: Partial<WalletConnection> = {}): WalletConnection {
  return {
    address: connectedWallet,
    connected: true,
    connect: () => undefined,
    disconnect: () => undefined,
    isMobile: false,
    walletsCount: 1,
    connectionError: "",
    signTransaction: async (transaction) => transaction,
    ...overrides,
  };
}

function render(
  props: { initialMint?: string; initialWallet?: string } = {},
  overrides: Partial<WalletConnection> = {},
) {
  return renderToStaticMarkup(
    createElement(
      WalletConnectionContext.Provider,
      { value: connection(overrides) },
      createElement(PositionPerformancePanel, props),
    ),
  );
}

describe("PositionPerformancePanel without the NFT-mint lookup", () => {
  it("offers the connected wallet's positions and no manual mint or wallet fields", () => {
    const markup = render();
    expect(markup).toContain("Connected wallet positions");
    expect(markup).toContain('id="perf-position"');
    expect(markup).not.toContain("Look up another position by NFT mint");
    expect(markup).not.toContain("Position NFT mint (base58)");
    expect(markup).not.toContain('id="perf-wallet"');
  });

  it("a URL mint and wallet still drive the read without showing the lookup", () => {
    const markup = render({ initialMint: urlMint, initialWallet: urlWallet });
    expect(markup).not.toContain("Look up another position by NFT mint");
    expect(markup).not.toContain('id="perf-wallet"');
    expect(markup).not.toContain("Use connected wallet");
  });

  it("disconnected: no picker and no manual fields", () => {
    const markup = render({}, { connected: false, address: undefined });
    expect(markup).not.toContain('id="perf-wallet"');
    expect(markup).not.toContain(`value="${connectedWallet}"`);
    expect(markup).not.toContain("Connected wallet positions");
  });
});
