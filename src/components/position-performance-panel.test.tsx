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

describe("PositionPerformancePanel wallet defaults", () => {
  it("pre-fills the wallet field from the connected wallet and offers a position picker", () => {
    const markup = render();
    expect(markup).toContain(`value="${connectedWallet}"`);
    expect(markup).toContain("Defaults to the connected wallet");
    expect(markup).toContain("Pre-filled from the connected wallet");
    expect(markup).toContain("Connected wallet positions");
    expect(markup).toContain('id="perf-position"');
    expect(markup).toContain("Position NFT mint (base58)");
    expect(markup).toContain("or pick one from the connected wallet");
    expect(markup).not.toContain("Use connected wallet");
  });

  it("lets URL mint and wallet take precedence and shows a reset affordance", () => {
    const markup = render({ initialMint: urlMint, initialWallet: urlWallet });
    expect(markup).toContain(`value="${urlMint}"`);
    expect(markup).toContain(`value="${urlWallet}"`);
    expect(markup).toContain("Use connected wallet");
  });

  it("stays empty when disconnected and no URL wallet is provided", () => {
    const markup = render({}, { connected: false, address: undefined });
    expect(markup).toContain('id="perf-wallet"');
    expect(markup).toContain("Defaults to the connected wallet");
    expect(markup).not.toContain(`value="${connectedWallet}"`);
    expect(markup).not.toContain("Use connected wallet");
    expect(markup).not.toContain("Connected wallet positions");
  });
});
