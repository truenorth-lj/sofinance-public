import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HIGHEST_RANGE_APR_7D_HELP,
  HOMEPAGE_APR_DOCS_LINK_LABEL,
  HOMEPAGE_POOL_APR_LABEL,
} from "@/lib/apr-labels/copy";

describe("landing page copy and routes", () => {
  const src = readFileSync(resolve("src/components/landing-page.tsx"), "utf8");
  const table = readFileSync(resolve("src/components/homepage-pools-table.tsx"), "utf8");
  const copyFiles = [
    "src/components/landing-page.tsx",
    "src/components/homepage-pools-table.tsx",
    "src/lib/homepage-pools.ts",
    "src/lib/homepage-pools-snapshot.ts",
    "src/lib/snapshot-updated.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/manifest.ts",
  ];

  it("leads with the option B hero (hold the stock, collect the fees), not a yield product", () => {
    expect(src).toContain("Hold the stock. Collect the fees.");
    expect(src).toContain(
      "Your $TSLA, $MSTR or $SPCX tokens can collect trading fees from swaps in Raydium (Solana) and Uniswap v4 (Robinhood Chain) pools. We show the estimated fee APR before you sign, plus a 7-day backtested range on Solana. Not guaranteed; risks apply.",
    );
    expect(src).not.toContain("LP tokenized stocks on Raydium — in one signature.");
    expect(src).toContain("You sign every transaction");
    expect(src).not.toMatch(/estimated APR/);
    expect(src).toContain("Self-custodial · Solana + Robinhood Chain");
    expect(src).not.toContain("Raydium CLMM · Tokenized stocks");
    expect(src).toContain("Browse pools");
    expect(src).toContain("Already have a position? Manage it");
    expect(src).toMatch(/non-custodial/i);
    expect(src).toContain("verifiable on Solscan and Blockscout");
    expect(src).not.toMatch(/audited|trustless|risk-free|fully automated|autonomous/i);
    // "trading" is allowed only as "trading fees" (approved option B subhead), never as a trading product.
    expect(src.replace(/trading fees/g, "")).not.toMatch(/\btrading\b/i);
  });

  it("has no yield or strategy headlines", () => {
    for (const file of copyFiles) {
      expect(readFileSync(resolve(file), "utf8"), file).not.toMatch(
        /\byield\b|\bearn\b|make your money|strateg|recipe/i,
      );
    }
  });

  it("does not claim to be open source", () => {
    expect(src).not.toMatch(/open[- ]source|\bMIT\b/i);
    expect(table).not.toMatch(/open[- ]source|\bMIT\b/i);
  });

  it("does not mention the prototype app, Turnkey, or a fee wallet", () => {
    for (const file of copyFiles) {
      expect(readFileSync(resolve(file), "utf8"), file).not.toMatch(/Turnkey|prototype app|fee wallet/i);
    }
  });

  it("uses the inline C3 BrandMark, not the old square logo image", () => {
    expect(src).toContain("BrandMark");
    expect(src).not.toContain("/logo.png");
    expect(src).not.toContain("next/image");
  });

  it("keeps /app reachable and deep-links Open position into the existing flow", () => {
    expect(src).toContain("APP_ROUTES.home");
    expect(src).toContain("APP_ROUTES.ai");
    expect(src).toContain("DOCS_ROUTES.home");
    expect(src).toContain("DOCS_ROUTES.risks");
    expect(src).toContain("BLOG_ROUTES.home");
    expect(src).toContain("HomepagePoolsTable");
    expect(table).toContain("APP_ROUTES.rwaPairs");
    expect(table).toContain("buildOpenPositionPath");
    expect(table).toContain("Open position");
    expect(table).toContain("fetchRwaPairsList");
    expect(src).not.toContain('href="/rwa-pairs"');
  });

  it("replaces the four-step technical flow with three user steps and drops engine jargon", () => {
    expect(src).toContain("Pick a pool");
    expect(src).toContain("On Solana the app suggests the best backtest range; you can override it.");
    expect(src).toContain("Review the preview");
    expect(src).toContain("Sign in your wallet");
    expect(src).not.toContain("The problem");
    expect(src).not.toContain("Three pillars");
    expect(src).not.toContain("Coming soon");
    expect(src).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
    expect(table).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
  });

  it("labels homepage APR with the cards' Est. highest range APR / not guaranteed copy", () => {
    expect(HOMEPAGE_POOL_APR_LABEL).toBe("Est. highest range APR · 7d avg · not guaranteed");
    expect(HOMEPAGE_APR_DOCS_LINK_LABEL).toBe("APR details");
    expect(`${HOMEPAGE_POOL_APR_LABEL} ${HIGHEST_RANGE_APR_7D_HELP} ${HOMEPAGE_APR_DOCS_LINK_LABEL}`).not.toMatch(
      /\byield\b|\bearn\b|make your money|strateg|recipe|open[- ]source|\bMIT\b/i,
    );
    expect(table).toContain("HOMEPAGE_POOL_APR_LABEL");
    expect(table).toContain("HIGHEST_RANGE_APR_7D_HELP");
    expect(table).toContain("DOCS_ROUTES.feeApr");
    expect(table).toContain("usePoolsApr7d"); // the /app/rwa-pairs APR state
    expect(table).not.toContain("@/lib/range-apr/format"); // the rounding formatter that showed tiny APRs as 0%
    expect(table).not.toContain("POOL_FEE_APR_24H_HELP");
  });

  it("claims the 7-day backtest for Solana only, in every public page, the metadata, docs, llms.txt and FAQ", () => {
    const files = [
      "src/components/landing-page.tsx",
      "src/app/page.tsx",
      "src/components/blog/blog-shell.tsx",
      "src/app/docs/fee-apr/page.tsx",
      "src/lib/llms-txt.ts",
      "src/lib/faq.ts",
      "content/blog/dex-evolution.md",
    ];
    for (const file of files) {
      const text = readFileSync(resolve(file), "utf8").replace(/\s+/g, " ");
      // Each sentence that mentions a backtest also names Solana (or Raydium, which is Solana-only here).
      for (const sentence of text.split(/(?<=[.!?])\s/)) {
        if (/backtest/i.test(sentence)) expect(sentence, `${file}: ${sentence}`).toMatch(/Solana|Raydium/);
      }
    }
    expect(readFileSync(resolve("src/app/page.tsx"), "utf8")).toContain("plus a 7-day backtested range on Solana");
  });

  it("covers both chains in the position, explorer and risk copy", () => {
    expect(src).toContain("Verifiable on Solscan and Blockscout");
    expect(src).toContain("Open it on Solscan (Solana) or Blockscout (Robinhood");
    expect(src).toContain("a Raydium position NFT on");
    expect(src).toContain("a Uniswap v4 position NFT on Robinhood Chain");
    expect(src).not.toContain("A normal Raydium position NFT");
    expect(src).not.toContain("Self-custodial Raydium CLMM tool");
    // "One signature" is Solana-only: Robinhood Chain needs a one-time approval, a signature and a transaction.
    expect(src).not.toMatch(/1 signature ·|You sign once|Sign once\./);
    expect(src).toContain("Est. fee APR is not guaranteed.");
    expect(src).not.toMatch(/guaranteed (yield|return|apr)|will earn|risk-free/i);
  });

  it("keeps public copy free of repo, location, education, prototype, Turnkey and 0-SOL wording", () => {
    for (const file of [...copyFiles, "src/components/mcp-connection-card.tsx"]) {
      const text = readFileSync(resolve(file), "utf8");
      expect(text, file).not.toMatch(/\brepo(sitory)?\b|github|open[- ]source|sofinance-public/i);
      expect(text, file).not.toMatch(/Turnkey|prototype|0[- ]SOL|zero SOL|fee wallet/i);
      expect(text, file).not.toMatch(/\b(Taipei|Taiwan|university|student|education)\b/i);
    }
  });
});
