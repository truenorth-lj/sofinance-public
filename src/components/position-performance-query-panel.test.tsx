import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { PositionPerformanceQueryPanel } from "./position-performance-query-panel";

const mint = "33333333333333333333333333333333";
const wallet = "22222222222222222222222222222222";
const { search } = vi.hoisted(() => ({ search: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => search,
}));

function connection(): WalletConnection {
  return {
    connected: false,
    connect: () => undefined,
    disconnect: () => undefined,
    isMobile: false,
    walletsCount: 0,
    connectionError: "",
    signTransaction: async (transaction) => transaction,
  };
}

function render() {
  return renderToStaticMarkup(
    createElement(
      WalletConnectionContext.Provider,
      { value: connection() },
      createElement(PositionPerformanceQueryPanel),
    ),
  );
}

describe("PositionPerformanceQueryPanel", () => {
  beforeEach(() => {
    search.delete("mint");
    search.delete("wallet");
    search.delete("positionMint");
  });

  it("prefills mint and wallet from the live URL search string", () => {
    search.set("mint", mint);
    search.set("wallet", wallet);
    const markup = render();
    expect(markup).toContain(`value="${mint}"`);
    expect(markup).toContain(`value="${wallet}"`);
  });

  it("does not invent values when the URL has no query", () => {
    const markup = render();
    expect(markup).not.toContain(`value="${mint}"`);
    expect(markup).not.toContain(`value="${wallet}"`);
    expect(markup).toContain('id="perf-wallet"');
  });
});
