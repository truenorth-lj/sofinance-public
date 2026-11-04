import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPEN_RANGE_PRESETS } from "@sofinance/engine/open-range-presets";
import {
  HIGHEST_RANGE_APR_7D_HELP,
  HOMEPAGE_APR_DOCS_LINK_LABEL,
} from "@/lib/apr-labels/copy";
import { LANDING_RANGES } from "./landing/ranges-section";
import { SAMPLE, SAMPLE_COSTS_NOTE, SAMPLE_FOOTNOTE, SAMPLE_ROWS, SAMPLE_SWAP_COST_PCT } from "./landing/landing-sample";
import { PLAN_SWAP_COST_BPS, planOpenCostPctLabel } from "@/lib/lp-plan-yield";

/** Source with comments and import lines removed, so the checks read only what can reach the page. */
const copyOf = (file: string) =>
  readFileSync(resolve(file), "utf8")
    .replace(/^import [\s\S]*?;$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
/** Words the public site must not use (the standing copy rules). */
const FORBIDDEN = /back-?test|\bearn(s|ed|ing|ings)?\b|\byield|auto-?rebalanc|guarantee/i;
/** The one allowed exception: risk lines keep exactly "Fees not guaranteed" (LJ via PM). */
const ALLOWED_PHRASE = /\bFees not guaranteed\b/g;
const withoutAllowed = (text: string) => text.replace(ALLOWED_PHRASE, "");

describe("landing page copy and routes", () => {
  const src = readFileSync(resolve("src/components/landing-page.tsx"), "utf8");
  const table = readFileSync(resolve("src/components/homepage-pools-table.tsx"), "utf8");
  const copyFiles = [
    "src/components/landing-page.tsx",
    "src/components/landing/pair-section.tsx",
    "src/components/landing/returns-section.tsx",
    "src/components/landing/ranges-section.tsx",
    "src/components/landing/section-heading.tsx",
    "src/components/landing/landing-sample.ts",
    "src/components/homepage-pools-table.tsx",
    "src/lib/homepage-pools.ts",
    "src/lib/homepage-pools-snapshot.ts",
    "src/lib/snapshot-updated.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/manifest.ts",
  ];

  it("leads with the same-stock hero: headline, plain subhead and View pools to the pools list", () => {
    expect(src).toContain("Hold your stocks. Collect fees.");
    expect(src).not.toContain("Hold the stock. Collect the fees.");
    expect(src).toContain("Pair two tokens of the same stock in one pool.");
    expect(src).not.toContain("LP tokenized stocks on Raydium — in one signature.");
    expect(src).toContain("You sign every transaction");
    expect(src).toContain("Self-custodial · Solana + Robinhood Chain");
    expect(src).not.toContain("Raydium CLMM · Tokenized stocks");
    // "View pools" goes straight to the pools list, never to an on-page anchor.
    expect(src).toMatch(/<ArrowCta href=\{APP_ROUTES\.rwaPairs\} tone="ink">\s*View pools\s*<\/ArrowCta>/);
    expect(src).not.toContain("Browse pools");
    const hero = src.slice(src.indexOf('data-testid="landing-hero"'), src.indexOf("<PairSection"));
    expect(hero).not.toMatch(/href="#pools"/);
    expect(hero).toContain("APP_ROUTES.rwaPairs");
    expect(src).toMatch(/non-custodial/i);
    expect(src).toContain("verifiable on Solscan and Blockscout");
    expect(src).not.toMatch(/audited|trustless|risk-free|fully automated|autonomous/i);
    expect(src).not.toContain("Next: range re-centering, rebalancing.");
    // "trading" is allowed only as "trading fees", never as a trading product.
    expect(src.replace(/trading fees/g, "")).not.toMatch(/\btrading\b/i);
  });

  it("orders the new explainer sections right after the hero, before the live pools", () => {
    const order = ["<PairSection", "<ReturnsSection", "<RangesSection", "<HomepagePoolsTable"].map((tag) => src.indexOf(tag));
    expect(order.every((index) => index > src.indexOf("</h1>"))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("uses none of the forbidden words in any landing copy", () => {
    for (const file of copyFiles) expect(withoutAllowed(copyOf(file)), file).not.toMatch(FORBIDDEN);
  });

  it("keeps the forbidden words out of the public pages, blog and app copy", () => {
    const files = [
      "src/app/page.tsx",
      "src/app/terms/page.tsx",
      "src/app/docs/fee-apr/page.tsx",
      "src/app/docs/risks/page.tsx",
      "src/components/blog/blog-shell.tsx",
      "content/blog/dex-evolution.md",
      "content/blog/xstocks-xpoints.md",
      "src/lib/apr-labels/copy.ts",
      "src/lib/range-apr/copy.ts",
      "src/components/selected-app.tsx",
      "src/components/compound-panel.tsx",
      "src/components/position-performance-summary.tsx",
      "src/components/open-position-modal.tsx",
      "src/components/plan/hodl-vs-pool.tsx",
      "src/components/unified-pools/share-calc-dialog.tsx",
      "src/lib/lp-plan-notice.ts",
    ];
    // Local variable names (e.g. `earn` in hodl-vs-pool) are code, not copy.
    const code = (text: string) => text.replace(/import .*$/gm, "").replace(/(const |\$?\{)earn\b/g, "$1_");
    for (const file of files) expect(withoutAllowed(code(copyOf(file))), file).not.toMatch(FORBIDDEN);
  });

  it("mentions APR nowhere in the landing's own copy (the pools table keeps its one estimate column)", () => {
    for (const file of copyFiles.filter((file) => file.includes("landing"))) {
      expect(copyOf(file).replace(/\b\w*Apr\w*\b|\b[A-Z_]*APR[A-Z_0-9]*\b/g, ""), file).not.toMatch(/APR|APY/);
    }
    expect(copyOf("src/app/page.tsx")).not.toMatch(/\bAPR\b/);
    expect(table).not.toMatch(/apr24h|hideApr24h|APR · 24h/i); // one APR site-wide: the 7-day estimate
  });

  it("has no yield or strategy headlines", () => {
    for (const file of copyFiles) {
      expect(copyOf(file), file).not.toMatch(
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
    expect(table).toContain("fetchRwaPairsList");
    // The homepage reuses the /app/rwa-pairs list view (same PoolTable, Open action, selectPools order), capped at 5.
    expect(table).toContain('from "./unified-pools/pool-list"');
    expect(table).toContain("<PoolTable");
    expect(table).toContain("homepageRows(");
    expect(table).toContain("View all pools");
    expect(table).not.toMatch(/<table|homepage-pools-cards/);
    expect(src).not.toContain('href="/rwa-pairs"');
  });

  it("replaces the four-step technical flow with three user steps and drops engine jargon", () => {
    expect(src).toContain("Pick a pool");
    expect(src).toContain("On Solana the app suggests a range picked from the past 7 days of fee data; you can change it.");
    // One signature only for a Raydium USDC open; SOL and Meteora take two.
    expect(src).toContain("Raydium: opening with USDC takes one signature; with SOL it takes two. Meteora: two transactions.");
    expect(src).toContain("Review the preview");
    expect(src).toContain("Sign in your wallet");
    expect(src).not.toContain("The problem");
    expect(src).not.toContain("Three pillars");
    expect(src).not.toContain("Coming soon");
    expect(src).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
    expect(table).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
  });

  it("ranks homepage pools by the /app/rwa-pairs 7-day estimate with a plain help and docs link", () => {
    expect(HOMEPAGE_APR_DOCS_LINK_LABEL).toBe("How estimates work");
    expect(`${HIGHEST_RANGE_APR_7D_HELP} ${HOMEPAGE_APR_DOCS_LINK_LABEL}`).not.toMatch(FORBIDDEN);
    expect(table).toContain("Ranked by the 7-day estimate, high to low (on Solana, for a range picked from the past 7 days of fee data).");
    expect(table).toContain("Top pools on Solana and Robinhood Chain");
    expect(table).not.toContain("by est. 7-day APR");
    expect(table).toContain("HIGHEST_RANGE_APR_7D_HELP");
    expect(table).toContain("DOCS_ROUTES.feeApr");
    expect(table).toContain("usePoolsApr7d"); // the /app/rwa-pairs APR state
    expect(table).toContain("DEFAULT_SORT");
    expect(table).not.toContain("@/lib/range-apr/format"); // the rounding formatter that showed tiny APRs as 0%
    expect(table).not.toContain("POOL_FEE_APR_24H_HELP");
  });

  it("describes Solana ranges as picked from the past 7 days of fee data, never as backtested", () => {
    const files = [
      "src/components/landing-page.tsx",
      "src/components/landing/ranges-section.tsx",
      "src/app/page.tsx",
      "src/components/blog/blog-shell.tsx",
      "src/app/docs/fee-apr/page.tsx",
      "src/lib/llms-txt.ts",
      "src/lib/faq.ts",
      "content/blog/dex-evolution.md",
    ];
    for (const file of files) expect(copyOf(file), file).not.toMatch(/back-?test/i);
    expect(copyOf("src/components/landing/ranges-section.tsx")).toContain("picked from the past 7");
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
    expect(src).toContain("Fees not guaranteed. Fee estimates are not a prediction.");
    expect(withoutAllowed(src)).not.toMatch(/guaranteed|will earn|risk-free/i);
  });

  it("keeps public copy free of repo, location, education, prototype, Turnkey and 0-SOL wording", () => {
    for (const file of [...copyFiles, "src/components/mcp-connection-card.tsx"]) {
      const text = readFileSync(resolve(file), "utf8");
      expect(text, file).not.toMatch(/\brepo(sitory)?\b|github|open[- ]source|sofinance-public/i);
      expect(text, file).not.toMatch(/Turnkey|prototype|0[- ]SOL|zero SOL|fee wallet/i);
      expect(text, file).not.toMatch(/\b(Taipei|Taiwan|university|student|education)\b/i);
      expect(copyOf(file), file).not.toMatch(/\b(LJ|Lin)\b/);
    }
  });

  it("has no Issuer controls item in the Risks list, and the remaining three items leave no empty grid slot", () => {
    expect(src).not.toMatch(/Issuer controls|freeze or other controls|depends on both issuers/i);
    const risks = src.slice(src.indexOf('label="Risks"'), src.indexOf('id="agents"'));
    expect(risks.match(/<li\b/g)).toHaveLength(3);
    expect(risks).toContain('<li className="sm:col-span-2">');
    expect(risks).toContain("Read the full list in");
  });

  it("shows the 24h hold vs pool sample from the real HOODx/HOOD series, with the exact footnote and no SOL chart", () => {
    const returns = readFileSync(resolve("src/components/landing/returns-section.tsx"), "utf8");
    expect(SAMPLE_FOOTNOTE).toBe("Simulated $1,000 position on real pool data, not a prediction. One 24h sample.");
    expect(returns).toContain("SAMPLE_FOOTNOTE");
    expect(SAMPLE).toMatchObject({ holdEndUsd: 1026.72, poolEndUsd: 1032.17, holdPct: 2.67, poolPct: 3.22, diffUsd: 5.45, feesUsd: 5.43 });
    const last = SAMPLE_ROWS.at(-1)!;
    expect([last[2], last[3], last[4]]).toEqual([SAMPLE.holdEndUsd, SAMPLE.poolEndUsd, SAMPLE.feesUsd]);
    expect(Number((SAMPLE.poolEndUsd - SAMPLE.holdEndUsd).toFixed(2))).toBe(SAMPLE.diffUsd);
    expect(Number(((SAMPLE.holdEndUsd / SAMPLE.depositUsd - 1) * 100).toFixed(2))).toBe(SAMPLE.holdPct);
    expect(Number(((SAMPLE.poolEndUsd / SAMPLE.depositUsd - 1) * 100).toFixed(2))).toBe(SAMPLE.poolPct);
    for (const file of copyFiles.filter((file) => file.includes("landing"))) {
      const text = copyOf(file);
      expect(text, file).not.toMatch(/\b711\b|SOL\/USDC|SOLUSDC/);
    }
    expect(copyOf("src/components/landing/returns-section.tsx")).toContain("Low is not zero");
  });

  it("names the range cards after the app's real presets, Standard as the default", () => {
    const presets = OPEN_RANGE_PRESETS.map((preset) => [preset.label.replace(/\s*\(.*\)$/, ""), `±${preset.percentBps / 100}%`]);
    expect(LANDING_RANGES.map((range) => [range.name, range.band])).toEqual(presets);
    expect(LANDING_RANGES.map((range) => range.name)).toEqual(["Tight", "Standard", "Wide"]);
    expect(LANDING_RANGES.find((range) => range.isDefault)?.name).toBe("Standard");
  });

  it("allows only the exact phrase \"Fees not guaranteed\", and only on risk lines", () => {
    expect(withoutAllowed("Fees not guaranteed. Not a prediction.")).not.toMatch(FORBIDDEN);
    for (const other of ["Returns not guaranteed", "fees not guaranteed", "guaranteed fees"]) {
      expect(withoutAllowed(other), other).toMatch(FORBIDDEN);
    }
    const risks = src.slice(src.indexOf('label="Risks"'), src.indexOf('id="agents"'));
    expect(risks).toContain("Fees not guaranteed.");
    expect(src.split("Fees not guaranteed").length - 1).toBe(1);
  });

  it("labels the 24h sample as fees vs holding and states the calculator's open and close costs", () => {
    const returns = readFileSync(resolve("src/components/landing/returns-section.tsx"), "utf8");
    const ranges = readFileSync(resolve("src/components/landing/ranges-section.tsx"), "utf8");
    expect(SAMPLE_SWAP_COST_PCT).toBe(planOpenCostPctLabel(PLAN_SWAP_COST_BPS));
    expect(SAMPLE_COSTS_NOTE).toContain(`about ${SAMPLE_SWAP_COST_PCT}% each way to and from USDC`);
    expect(SAMPLE_COSTS_NOTE).toContain("are not included");
    expect(returns).toContain("pool fees vs just holding");
    expect(returns).toContain("{SAMPLE_COSTS_NOTE}");
    expect(ranges).toContain("{SAMPLE_SWAP_COST_PCT}% each way to and from USDC) are not included");
    for (const text of [returns, ranges]) {
      expect(text).not.toMatch(/\$1 entry fee|entry fee;|not modelled/);
    }
    // "Over this one day they would be more than the fees": both swaps together cost more than the sample's gain.
    expect((2 * PLAN_SWAP_COST_BPS * SAMPLE.depositUsd) / 10_000).toBeGreaterThan(SAMPLE.diffUsd);
  });
});
