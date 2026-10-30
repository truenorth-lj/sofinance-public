import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FAQ_ITEMS, FAQ_SECTIONS } from "@/lib/faq";
import { DEFAULT_SWAP_FEE_BPS } from "@sofinance/engine/swap/fee";
import { OPEN_FEE_BPS } from "@sofinance/engine/protocols/uniswap-v4/open-constants";
import { RHC_EXPLORER_TX } from "@/lib/rhc-wallet/open-execute";
import { listToolDefinitions } from "@/mcp/tool-definitions";

vi.mock("@/components/ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ink")>()),
  InkNav: () => null,
}));

import FaqPage from "./page";

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("/faq", () => {
  const html = renderToStaticMarkup(<FaqPage />);
  const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, "<"));

  it("ships FAQPage JSON-LD that matches the visible questions and answers exactly", () => {
    expect(jsonLd["@type"]).toBe("FAQPage");
    expect(jsonLd.url).toBe("https://sofinancelab.xyz/faq");
    expect(jsonLd.mainEntity).toHaveLength(FAQ_ITEMS.length);
    const visible = decode(html.replace(/<script[\s\S]*?<\/script>/, ""));
    for (const [index, item] of FAQ_ITEMS.entries()) {
      expect(jsonLd.mainEntity[index]).toEqual({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      });
      expect(visible).toContain(item.question);
      expect(visible).toContain(item.answer);
    }
    expect(FAQ_SECTIONS.length).toBe(3);
  });

  it("covers Robinhood Chain and keeps the public-copy rules", () => {
    const copy = FAQ_ITEMS.map((item) => `${item.question} ${item.answer}`).join("\n");
    expect(copy).toContain("Robinhood Chain");
    expect(copy).toContain("Uniswap v4");
    expect(copy).toContain("11 Uniswap v4 pools");
    expect(copy).not.toMatch(/\byield|\bearn/i);
    expect(copy).not.toMatch(/open[- ]source|github|Turnkey|0-SOL|zero[- ]SOL|fee wallet|Taiwan|prototype/i);
    expect(copy.replaceAll("0.10%", "")).not.toMatch(/\d\s*%/); // only the fixed 0.10% fee, never an APR figure
    expect(copy).not.toContain("yield-and-apr");
  });

  it("states only claims the code backs (fees, wallets, explorers, MCP scope)", () => {
    const answer = (question: string) => FAQ_ITEMS.find((item) => item.question === question)!.answer;
    // 0.10% is the Solana default and the Robinhood Chain code constant.
    expect(DEFAULT_SWAP_FEE_BPS).toBe(10);
    expect(OPEN_FEE_BPS).toBe(10n);
    const cost = answer("How much does SoFinance cost?");
    expect(cost).toContain("On Solana:");
    expect(cost).toContain("On Robinhood Chain:");
    expect(cost).toContain("closing a position has no SoFinance fee");
    expect(cost).toContain("no option to convert them to USDC");
    // Wallets: no adapters are registered by name, so only "such as Phantom"; RHC = EIP-6963, MetaMask first.
    const wallets = answer("Which wallet do I need?");
    expect(wallets).toContain("such as Phantom");
    expect(wallets).toContain("EIP-6963");
    expect(wallets).not.toMatch(/Solflare|Backpack/);
    // Explorers: the hosts the UI links to.
    const custody = answer("Is SoFinance custodial? What if the site goes offline?");
    expect(custody).toContain("solscan.io");
    expect(custody).toContain(new URL(RHC_EXPLORER_TX).host);
    // MCP: Solana only; no Robinhood Chain / Uniswap tool exists.
    const tools = JSON.stringify([...listToolDefinitions("http"), ...listToolDefinitions("stdio")]);
    expect(tools).not.toMatch(/robinhood|uniswap|univ4|rhc/i);
    expect(answer("Can an AI agent use SoFinance for me?")).toContain("Robinhood Chain pools are not available through the MCP server");
  });

  it("is a static page", () => {
    expect(readFileSync(resolve("src/app/faq/page.tsx"), "utf8")).toContain('export const dynamic = "force-static"');
  });
});
