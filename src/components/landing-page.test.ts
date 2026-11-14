import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HIGHEST_RANGE_APR_7D_HELP,
  HOMEPAGE_APR_DOCS_LINK_LABEL,
} from "@/lib/apr-labels/copy";

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
  const market = readFileSync(resolve("src/components/homepage-market.tsx"), "utf8");
  const table = readFileSync(resolve("src/components/homepage-pools-table.tsx"), "utf8");
  const copyFiles = [
    "src/components/landing-page.tsx",
    "src/components/homepage-market.tsx",
    "src/components/homepage-pools-table.tsx",
    "src/components/stocks/stock-cards.tsx",
    "src/lib/homepage-pools.ts",
    "src/lib/homepage-pools-snapshot.ts",
    "src/lib/snapshot-updated.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/manifest.ts",
  ];

  it("leads with the market hero: headline, plain subhead, pool search and the self-custody line", () => {
    expect(market).toContain('Hold your stocks. <span className="text-lemon">Collect fees.</span>');
    expect(market).toContain("Pair two tokens of the same stock in one pool and collect a share of the swap fees.");
    expect(market).toContain("Self-custodial · Solana + Robinhood Chain");
    expect(market).toContain("0 keys on our servers · verifiable on Solscan and Blockscout");
    expect(market).toContain('role="search"');
    expect(market).toContain('placeholder="Search SPCX, TSLA, AAPL…"');
    // Searching scrolls to the pools list on the page; it never leaves the homepage.
    expect(market).toContain('getElementById("pools")');
    expect(market).not.toMatch(/audited|trustless|risk-free|fully automated|autonomous/i);
    // "trading" is allowed only as "trading fees", never as a trading product.
    for (const text of [src, market, table]) expect(text.replace(/trading fees/g, "")).not.toMatch(/\btrading\b/i);
  });

  it("orders the page like a market page: hero, the three cards, then every pool", () => {
    const order = ['data-testid="landing-hero"', "<StockCards", "<TopPoolsCard", "<HomepagePoolsList"].map((tag) => market.indexOf(tag));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(src).toContain("<HomepageMarket ");
    expect(src).toContain("<HomepageMarketView ");
  });

  it("drops the explainer sections (pair, sample, ranges, how it works, keys, risks, agents) from the homepage", () => {
    expect(existsSync(resolve("src/components/landing"))).toBe(false);
    for (const gone of ["PairSection", "ReturnsSection", "RangesSection", 'id="how"', 'id="agents"', 'label="Risks"']) {
      expect(src, gone).not.toContain(gone);
      expect(market, gone).not.toContain(gone);
    }
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
      "src/components/site-header.tsx",
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

  it("mentions APR nowhere in the page's own copy (only the pools card and table keep the one 7-day estimate)", () => {
    for (const file of ["src/components/landing-page.tsx", "src/components/homepage-market.tsx"]) {
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
    for (const text of [src, market, table]) expect(text).not.toMatch(/open[- ]source|\bMIT\b/i);
  });

  it("does not mention the prototype app, Turnkey, or a fee wallet", () => {
    for (const file of copyFiles) {
      expect(readFileSync(resolve(file), "utf8"), file).not.toMatch(/Turnkey|prototype app|fee wallet/i);
    }
  });

  it("uses the cream squircle H mark in the header, not the old square logo image", () => {
    // The header moved to SiteHeader (shared with blog, docs, FAQ and terms).
    expect(src).toContain("<SiteHeader onHomepage />");
    const header = readFileSync(resolve("src/components/site-header.tsx"), "utf8");
    expect(header).toContain("/navbar-mark-squircle-cream.svg");
    expect(header).toContain("h-9 w-9");
    expect(header).toContain("gap-2.5");
    expect(header).toContain("font-display");
    expect(header).toContain("text-[20px]");
    expect(header).toContain("font-bold");
    expect(header).toContain("text-cream");
    expect(header).not.toContain("BrandMark");
    expect(header).not.toContain("text-lemon");
    expect(header).not.toContain("bg-lemon");
    expect(header).not.toContain("pl-[7px]");
    expect(header).not.toContain("pl-1.5");
    expect(header).not.toContain("/logo.png");
    expect(src).not.toContain("/logo.png");
    expect(src).not.toContain("next/image");
  });

  it("keeps /app, agents, docs and risks reachable and deep-links Open position into the existing flow", () => {
    expect(src).toContain("APP_ROUTES.home");
    expect(src).toContain("APP_ROUTES.ai");
    expect(src).toContain("DOCS_ROUTES.home");
    expect(src).toContain("DOCS_ROUTES.risks");
    expect(src).toContain("BLOG_ROUTES.home");
    expect(table).toContain("APP_ROUTES.rwaPairs");
    // Open follows the pools page's own rule (registry DEXes such as Meteora open their dialog), never a stale "not available".
    expect(table).toContain("dexDescriptors.descriptorFor(pool.protocol)?.capabilities.open");
    expect(table).toContain("?openPool=");
    expect(table).not.toContain("openUnavailableReason");
    expect(table).toContain("fetchRwaPairsList");
    // The list is the /app/rwa-pairs list view (same PoolTable, Open action, selectPools order); Top Pools is its top 5.
    expect(table).toContain('from "./unified-pools/pool-list"');
    expect(table).toContain("<PoolTable");
    expect(table).toContain("selectPools(");
    expect(table).toContain("RWA_PAIRS_DEFAULT_SELECT");
    expect(table).toContain("homepageRows(");
    expect(table).toContain("Open in app →");
    expect(table).not.toMatch(/<table|homepage-pools-cards/);
    expect(src).not.toContain('href="/rwa-pairs"');
    expect(table).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
  });

  it("ranks homepage pools by the /app/rwa-pairs 7-day estimate with a plain help and docs link", () => {
    expect(HOMEPAGE_APR_DOCS_LINK_LABEL).toBe("How estimates work");
    expect(withoutAllowed(`${HIGHEST_RANGE_APR_7D_HELP} ${HOMEPAGE_APR_DOCS_LINK_LABEL}`)).not.toMatch(FORBIDDEN);
    expect(HIGHEST_RANGE_APR_7D_HELP).toContain("$1,000 deposit");
    expect(HIGHEST_RANGE_APR_7D_HELP).not.toMatch(/\$100\b|APR/);
    expect(table).toContain("Ranked by the 7-day estimate, high to low (on Solana, for a range picked from the past 7 days of fee data).");
    expect(table).toContain("All pools");
    expect(table).toContain('title="Top Pools"');
    expect(table).not.toContain("by est. 7-day APR");
    expect(table).toContain("HIGHEST_RANGE_APR_7D_HELP");
    expect(table).toContain("DOCS_ROUTES.feeApr");
    expect(table).toContain("usePoolsApr7d"); // the /app/rwa-pairs APR state
    expect(table).toContain("DEFAULT_SORT");
    expect(table).not.toContain("@/lib/range-apr/format"); // the rounding formatter that showed tiny APRs as 0%
    expect(table).not.toContain("POOL_FEE_APR_24H_HELP");
  });

  it("keeps the risk lines next to the pools: not LP return, out of range, and a Risks link", () => {
    expect(table).toContain("Not LP return; ignores IL and rewards.");
    expect(table).toContain("A position out of its range collects no fees.");
    expect(table).toContain("DOCS_ROUTES.risks");
    // "Fees not guaranteed" reaches the list only through the shared estimate help, never as a new claim.
    expect(HIGHEST_RANGE_APR_7D_HELP).toContain("Fees not guaranteed.");
    for (const text of [src, market, table]) expect(withoutAllowed(text)).not.toMatch(/guaranteed|will earn|risk-free/i);
  });

  it("describes Solana ranges as picked from the past 7 days of fee data, never as backtested", () => {
    const files = [
      "src/components/landing-page.tsx",
      "src/components/homepage-market.tsx",
      "src/components/homepage-pools-table.tsx",
      "src/app/page.tsx",
      "src/components/blog/blog-shell.tsx",
      "src/app/docs/fee-apr/page.tsx",
      "src/lib/llms-txt.ts",
      "src/lib/faq.ts",
      "content/blog/dex-evolution.md",
    ];
    for (const file of files) expect(copyOf(file), file).not.toMatch(/back-?test/i);
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
});

describe("continuous corners", () => {
  const css = readFileSync(resolve("src/app/globals.css"), "utf8");

  it("keeps the radius tokens: 28px surfaces, 16px inset boxes unless a surface sets its own", () => {
    expect(css).toMatch(/--radius-surface: 1\.75rem;/);
    expect(css).toMatch(/--radius-inset: 1rem;/);
    // The shared input and status boxes read the inset token, so the Buy modal can set theirs to 8px.
    const tools = readFileSync(resolve("src/components/unified-positions/registry-tools.tsx"), "utf8");
    expect(tools).toMatch(/export const FIELD = "w-full rounded-inset /);
    expect(tools.match(/rounded-inset border border-white\/20 bg-white\/\[0\.04\] p-3/g)).toHaveLength(3);
  });

  it("draws superellipse corners on the homepage only where supported, with pills and circles left round", () => {
    const block = css.match(/@supports \(corner-shape: superellipse\(1\.25\)\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(block).toContain(":where(.continuous-corners, .continuous-corners *) { corner-shape: superellipse(1.25); }");
    expect(block).toContain(":where(.continuous-corners .rounded-full) { corner-shape: round; }");
    expect(css.replace(block, "")).not.toContain("corner-shape");
    expect(readFileSync(resolve("src/components/landing-page.tsx"), "utf8")).toContain('<div className="continuous-corners ');
  });
});
