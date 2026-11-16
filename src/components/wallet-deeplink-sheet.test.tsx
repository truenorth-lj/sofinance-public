import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { phantomBrowseUrl, solflareBrowseUrl } from "@/lib/analytics/wallet-connect";
import { WalletDeeplinkSheet } from "./wallet-deeplink-sheet";

const PAGE = "https://sofinancelab.xyz/app/portfolio?ref=x-launch";
const ORIGIN = "https://sofinancelab.xyz";
const FORBIDDEN = /\b(backtest|earn|yield|auto-rebalance|guaranteed)\b/i;

describe("WalletDeeplinkSheet", () => {
  it("renders official browse links and plain-language copy, and stays hidden when closed", () => {
    expect(renderToStaticMarkup(createElement(WalletDeeplinkSheet, {
      open: false, pageUrl: PAGE, origin: ORIGIN, onOpenWallet: vi.fn(), onChooseWalletHere: vi.fn(), onClose: vi.fn(),
    }))).toBe("");

    const html = renderToStaticMarkup(createElement(WalletDeeplinkSheet, {
      open: true, pageUrl: PAGE, origin: ORIGIN, onOpenWallet: vi.fn(), onChooseWalletHere: vi.fn(), onClose: vi.fn(),
    }));
    expect(html).toContain("Open in your wallet");
    expect(html).toContain("No wallet was found in this browser. Open this page in Phantom or Solflare to connect.");
    expect(html).toContain("Open in Phantom");
    expect(html).toContain("Open in Solflare");
    expect(html).toContain("Choose a wallet here");
    expect(html).toContain(`href="${phantomBrowseUrl(PAGE, ORIGIN)}"`);
    expect(html).toContain(`href="${solflareBrowseUrl(PAGE, ORIGIN)}"`);
    expect(html).toContain("https://phantom.com/ul/browse/");
    expect(html).toContain("https://solflare.com/ul/v1/browse/");
    expect(html).not.toMatch(FORBIDDEN);
  });
});
