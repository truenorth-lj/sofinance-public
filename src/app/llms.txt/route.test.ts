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

  it("keeps the public-copy rules", async () => {
    const text = await GET().text();
    expect(text).not.toContain("yield-and-apr");
    expect(text).not.toMatch(/\byield|\bearn/i);
    expect(text).not.toMatch(/github|open[- ]source|Turnkey|0-SOL|fee wallet|Taiwan|prototype/i);
    expect(text.replaceAll("0.10%", "")).not.toMatch(/\d\s*%/); // the fixed fee only, never an APR figure
  });
});
