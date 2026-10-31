import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OPEN_FEE_BPS } from "@sofinance/engine/protocols/uniswap-v4/open-constants";
import { RHC_EXPLORER_TX } from "@/lib/rhc-wallet/open-execute";

vi.mock("@/components/ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ink")>()),
  InkNav: () => null,
}));

import DocsRisksPage from "./page";

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("/docs/risks Robinhood Chain section", () => {
  const html = renderToStaticMarkup(<DocsRisksPage />);
  const start = html.indexOf('<h2 id="robinhood-chain">');
  const section = decode(html.slice(start, html.indexOf("</ul>", start)));

  it("renders an anchored Robinhood Chain section after the existing risks list", () => {
    expect(start).toBeGreaterThan(html.indexOf("Network conditions"));
    expect(section).toContain("Robinhood Chain pools");
    expect(section).toContain("chain ID 4663");
  });

  it("states only code- or chain-backed facts and defers issuer powers to issuer terms", () => {
    expect(section).toContain("7-day backtest in the create-position flow is Solana-only");
    expect(section).toContain(`${OPEN_FEE_BPS} bps of the tokens the swap returns`);
    expect(section).toContain("no SoFinance fee");
    expect(section).toContain("single externally owned wallet");
    expect(section).toContain("see issuer terms");
    expect(section).toContain(new URL(RHC_EXPLORER_TX).host);
  });

  it("makes no freeze, pause, blocklist or issuer-controls claim and no public-copy violations (the docs-wide guard in docs-nav.test.ts covers the rest)", () => {
    expect(section).not.toMatch(/freez|frozen|pause|blocklist|blacklist|issuer controls/i);
    expect(section).not.toMatch(/open[- ]source|github|repo\b|fee wallet|prototype|guarantee/i);
  });
});
