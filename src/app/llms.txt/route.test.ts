import { describe, expect, it } from "vitest";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { dynamic, GET } from "./route";

describe("/llms.txt", () => {
  it("serves a static plain-text site map for AI assistants", async () => {
    expect(dynamic).toBe("force-static");
    const response = GET();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text.startsWith("# SoFinance\n\n> ")).toBe(true);
    for (const page of DOCS_PAGES) expect(text).toContain(`(https://sofinancelab.xyz${page.href})`);
    expect(text).toContain("https://sofinancelab.xyz/docs/fee-apr");
    expect(text).toContain("https://sofinancelab.xyz/faq");
    expect(text).toContain("Robinhood Chain (Uniswap v4, StablePairHook, 11 pools)");
    expect(text.match(/^- [A-Z]+ \/ [A-Z]+on /gm)).toHaveLength(11);
    expect(text).toContain("NVDA / NVDAx");
  });

  it("lists the Meteora DLMM pools and the Solana pools added since the last review (SPY, TTWO)", async () => {
    const text = await GET().text();
    expect(text).toContain("Solana (Meteora DLMM, 2 pools)");
    expect(text).toContain("- TSLA / TSLAx (Tesla)\n");
    expect(text).toContain("- SPY / SPYx (S&P 500 ETF)");
    expect(text).toContain("- TTWO / TTWOx (Take-Two Interactive)");
    expect(text).toContain("INTC / INTCx (Intel), two fee tiers");
    expect(text).toContain("https://sofinancelab.xyz/api/mcp");
  });

  it("lists the guide pages (pricing, learn, use cases) in a Guides section before Docs", async () => {
    const text = await GET().text();
    const guides = text.slice(text.indexOf("## Guides\n"), text.indexOf("## Docs\n"));
    expect(text.indexOf("## Guides\n")).toBeGreaterThan(0);
    expect(guides).toContain("- [Pricing](https://sofinancelab.xyz/fees): zero performance fee; 0.10% only when we swap for you; withdrawing as the two pool tokens costs 0\n");
    for (const path of ["/learn/what-is-a-same-stock-lp-pool", "/learn/how-to-open-an-lp-position", "/learn/impermanent-loss-on-same-stock-pools",
      "/use-cases/tsla-same-stock-lp", "/use-cases/spcx-same-stock-lp"]) expect(guides).toContain(`(https://sofinancelab.xyz${path})`);
    expect(guides.match(/^- \[/gm)).toHaveLength(6);
  });

  it("keeps the public-copy rules", async () => {
    const text = await GET().text();
    expect(text).not.toContain("yield-and-apr");
    expect(text).not.toMatch(/\byield|\bearn/i);
    expect(text).not.toMatch(/github|open[- ]source|Turnkey|0-SOL|fee wallet|Taiwan|prototype/i);
    expect(text.replaceAll("0.10%", "")).not.toMatch(/\d\s*%/); // the fixed fee only, never an APR figure
  });

  it("makes no issuer-controls / freeze claim (matches the landing page and FAQ)", async () => {
    const text = await GET().text();
    expect(text).not.toMatch(/issuer controls|issuer authorit|freez/i);
    expect(text).toContain("Smart contract risk in Raydium");
  });
});
