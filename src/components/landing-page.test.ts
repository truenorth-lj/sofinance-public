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
  const results = readFileSync(resolve("src/components/unified-pools/pool-results.tsx"), "utf8");
  const urls = readFileSync(resolve("src/lib/public-urls.ts"), "utf8");
  const openAction = readFileSync(resolve("src/lib/unified-pools/open-action.ts"), "utf8");
  const copyFiles = [
    "src/components/landing-page.tsx",
    "src/components/homepage-market.tsx",
    "src/components/homepage-pools-table.tsx",
    "src/components/homepage-fee-estimator.tsx",
    "src/components/unified-pools/pool-results.tsx",
    "src/components/stocks/stock-cards.tsx",
    "src/lib/homepage-pools.ts",
    "src/lib/homepage-pools-snapshot.ts",
    "src/lib/snapshot-updated.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/manifest.ts",
  ];

  it("leads with the plan A hero: exact H1, subline, See pools, How it works, and three trust links", () => {
    expect(market).toContain('Hold the stock. <span className="text-lemon">Collect the fees.</span>');
    expect(market).toContain("Hold the stock. Collect the fees.");
    expect(market).toContain("Put two tokens of the same stock, like TSLAx and TSLA, in one pool. Traders swap between them, and you collect a share of the swap fees.");
    expect(market).toContain("See pools");
    expect(market).toContain("How it works");
    expect(market).toContain("GUIDE_ROUTES.whatIsSameStock");
    expect(market).toContain("TOP_POOLS_ANCHOR_ID");
    expect(market).toContain("Self-custodial: we never hold your keys");
    expect(market).toContain("DOCS_ROUTES.security");
    expect(market).toContain("Zero performance fee");
    expect(market).toContain("GUIDE_ROUTES.fees");
    expect(market).toContain("Solana + Robinhood Chain");
    expect(market).toContain("DOCS_ROUTES.home");
    // Hero search, pill and backdrop are gone; /pools ?q= support lives on that page, not here.
    expect(market).not.toContain("PoolSearchInput");
    expect(market).not.toContain("hero-search");
    expect(market).not.toContain("rwaPairsSearchHref");
    expect(market).not.toContain("IconBackdrop");
    expect(market).not.toContain("role=\"search\"");
    expect(market).not.toMatch(/Hold your stocks|Collect fees\./);
    expect(market).not.toMatch(/audited|trustless|risk-free|fully automated|autonomous/i);
    // "trading" is allowed only as "trading fees", never as a trading product. "Traders" in the mandated subline is fine.
    for (const text of [src, market, table, results]) expect(text.replace(/trading fees/g, "").replace(/\bTraders\b/g, "")).not.toMatch(/\btrading\b/i);
  });

  it("orders the page like a market page: hero, then the top-5 pools block, then stock cards", () => {
    const order = ['data-testid="landing-hero"', "<HomepageTopPools", "<StockCards"].map((tag) => market.indexOf(tag));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(market).not.toContain("<TopPoolsCard");
    expect(market).not.toContain("<HomepagePoolsList");
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
      "src/components/site-footer.tsx",
      "content/blog/dex-evolution.md",
      "content/blog/xstocks-xpoints.md",
      "content/blog/lp-position-out-of-range.md",
      "content/blog/compound-lp-trading-fees-raydium-meteora.md",
      "content/blog/same-stock-pool-vs-stock-usdc-pool.md",
      "content/blog/robinhood-chain-stock-lp-uniswap-v4.md",
      "content/blog/xstocks-multiplier-explained.md",
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

  it("keeps APY and the old \"Calculate shares\" label out of the calculator and plan copy (SP-2)", () => {
    const files = [
      "src/components/plan/comparison-chart.tsx",
      "src/components/plan/outcome-panel.tsx",
      "src/components/plan/plan-app.tsx",
      "src/components/plan/hodl-vs-pool.tsx",
      "src/components/plan/format.ts",
      "src/components/unified-pools/share-calc-dialog.tsx",
      "src/components/unified-pools/pool-card.tsx",
      "src/components/public-pool-page.tsx",
      "src/lib/unified-pools/calculate-label.ts",
      "src/components/homepage-fee-estimator.tsx",
    ];
    // `apyPct` and other camelCase identifiers are code, not copy.
    for (const file of files) {
      const text = copyOf(file).replace(/\b\w*Apy\w*\b|\b\w*apy\w*\b/g, "");
      expect(text, file).not.toMatch(/\bAPY\b/);
      expect(text, file).not.toMatch(/Calculate shares/);
      expect(withoutAllowed(text.replace(/(const |\$?\{)earn\b/g, "$1_")), file).not.toMatch(FORBIDDEN);
    }
  });

  it("puts the no-wallet fee estimator above the two hero buttons, with its mandated copy (SP-2)", () => {
    const estimator = readFileSync(resolve("src/components/homepage-fee-estimator.tsx"), "utf8");
    const order = ["<h1", "<HomepageFeeEstimator", 'data-testid="hero-see-pools"', 'data-testid="hero-how-it-works"', "<HomepageTopPools"].map((tag) => market.indexOf(tag));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(estimator).toContain('"Estimated fees collected"');
    expect(estimator).toContain('"Assumes price stays in range. Not a prediction. Fees not guaranteed."');
    expect(estimator).toContain('"Estimate unavailable right now"');
    // No wallet; its one request is the dialog's own `usePoolYield`, for the selected pool only.
    expect(estimator).not.toMatch(/useWallet|fetch\(|useSWR|\/api\//);
    expect(estimator).toContain("usePoolYield(readKey, { delayMs: ESTIMATOR_SWITCH_DEBOUNCE_MS })");
    expect(estimator).not.toMatch(/\bAPY\b/);
  });

  it("mentions APR nowhere in the page's own copy (only the pools card and table keep the one 7-day estimate)", () => {
    // The fee estimator (SP-2) is included: its only APR wording is the dialog's shared label (`planAprLabel`).
    const files = ["src/components/landing-page.tsx", "src/components/homepage-market.tsx", "src/components/homepage-fee-estimator.tsx"];
    for (const file of files) {
      expect(copyOf(file).replace(/\b\w*Apr\w*\b|\b[A-Z_]*APR[A-Z_0-9]*\b/g, ""), file).not.toMatch(/APR|APY/);
    }
    expect(copyOf("src/components/homepage-fee-estimator.tsx")).toContain("planAprLabel(best)");
    expect(copyOf("src/components/plan/pool-plan-basis.ts")).toContain("`Est. fee APR · ${aprWindowAvgLabel(window)}`");
    expect(copyOf("src/components/unified-pools/share-calc-dialog.tsx")).toContain("label={planAprLabel(best)}");
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
    expect(src).toContain("<SiteHeader />");
    const header = readFileSync(resolve("src/components/site-header.tsx"), "utf8");
    expect(header).toContain("<SiteLogo");
    expect(header).not.toContain("BrandMark");
    expect(header).not.toContain("/logo.png");
    const logo = readFileSync(resolve("src/components/site-logo.tsx"), "utf8");
    expect(logo).toContain("/navbar-mark-squircle-cream.svg");
    expect(logo).toContain("h-9 w-9");
    expect(logo).toContain("max-w-none");
    expect(logo).toContain("shrink-0");
    expect(logo).toContain("object-contain");
    expect(logo).toContain("gap-2.5");
    expect(logo).toContain("font-display");
    expect(logo).toContain("text-[20px]");
    expect(logo).toContain("font-bold");
    expect(logo).toContain("text-cream");
    expect(logo).not.toContain("BrandMark");
    expect(logo).not.toContain("text-lemon");
    expect(logo).not.toContain("bg-lemon");
    expect(logo).not.toContain("pl-[7px]");
    expect(logo).not.toContain("pl-1.5");
    expect(logo).not.toContain("/logo.png");
    expect(src).not.toContain("/logo.png");
    expect(src).not.toContain("next/image");
  });

  it("keeps /app, agents, docs and risks reachable and deep-links Open position into the existing flow", () => {
    expect(src).toContain("<SiteFooter variant=\"marketing\" />");
    const footer = readFileSync(resolve("src/components/site-footer.tsx"), "utf8");
    expect(footer).toContain("APP_ROUTES.home");
    expect(footer).toContain("APP_ROUTES.ai");
    expect(footer).toContain("DOCS_ROUTES.home");
    expect(footer).toContain("DOCS_ROUTES.risks");
    expect(footer).toContain("BLOG_ROUTES.home");
    expect(openAction).toContain("buildOpenPositionPath");
    expect(src).toContain("publicPoolDetailHrefs");
    expect(src).toContain("detailHrefs={detailHrefs}");
    // Native/generic capability refusal is covered by the homepage DOM and open-dispatch handler tests.
    expect(urls).toContain("?openPool=");
    expect(results).toContain("buildCalculatePath");
    expect(urls).toContain("?calc=");
    expect(table).not.toContain("openUnavailableReason");
    expect(table).toContain("fetchRwaPairsList");
    // The homepage top 5 is PoolResults in top mode; /pools keeps PoolResults in full mode (PoolTable / cards).
    expect(table).toContain('from "./unified-pools/pool-results"');
    expect(table).toContain('mode="top"');
    expect(table).toContain("homepageRows(");
    expect(results).toContain('mode === "full"');
    expect(results).toContain("<PoolTable");
    expect(results).toContain('data-testid="pools-cards"');
    expect(results).toContain("<PoolCard");
    expect(results).toContain('data-testid="top-pools-cards"');
    expect(results).toContain("md:grid-cols-3");
    expect(results).toContain("See all");
    expect(results).toContain("TOP_POOLS_TITLE");
    expect(results).not.toMatch(/same-stock/i);
    expect(src).not.toContain('href="/rwa-pairs"');
    expect(table).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
  });

  it("ranks homepage pools by the 7-day estimate in one top-5 block, with a plain help and docs link", () => {
    expect(HOMEPAGE_APR_DOCS_LINK_LABEL).toBe("How estimates work");
    expect(withoutAllowed(`${HIGHEST_RANGE_APR_7D_HELP} ${HOMEPAGE_APR_DOCS_LINK_LABEL}`)).not.toMatch(FORBIDDEN);
    expect(HIGHEST_RANGE_APR_7D_HELP).toContain("$1,000 deposit");
    expect(HIGHEST_RANGE_APR_7D_HELP).not.toMatch(/\$100\b|APR/);
    expect(results).toContain("TOP_POOLS_SUBTITLE");
    expect(results).toContain("HIGHEST_RANGE_APR_7D_HELP");
    expect(results).toContain("DOCS_ROUTES.feeApr");
    expect(table).toContain("usePoolsApr7d"); // the /pools APR state
    expect(table).not.toContain("All pools");
    expect(table).not.toContain("by est. 7-day APR");
    expect(table).not.toContain("@/lib/range-apr/format"); // the rounding formatter that showed tiny APRs as 0%
    expect(table).not.toContain("POOL_FEE_APR_24H_HELP");
    // The phrase family appears once, in the mandated subtitle, not as a column header.
    const pages = ["src/components/homepage-market.tsx", "src/components/homepage-pools-table.tsx", "src/components/unified-pools/pool-results.tsx", "src/components/landing-page.tsx", "src/lib/homepage-pools.ts"];
    const joined = pages.map((file) => copyOf(file)).join("\n");
    expect([...joined.matchAll(/7d estimated APR/g)]).toHaveLength(1);
    expect(joined).not.toMatch(/\b7d APR\b/);
  });

  it("keeps the risk lines next to the pools: not LP return, out of range, and a Risks link", () => {
    expect(results).toContain("Not LP return; ignores IL and rewards.");
    expect(results).toContain("A position out of its range collects no fees.");
    expect(results).toContain("DOCS_ROUTES.risks");
    // "Fees not guaranteed" reaches the list only through the shared estimate help, never as a new claim.
    expect(HIGHEST_RANGE_APR_7D_HELP).toContain("Fees not guaranteed.");
    for (const text of [src, market, table, results]) expect(withoutAllowed(text)).not.toMatch(/guaranteed|will earn|risk-free/i);
  });

  it("describes Solana ranges as picked from the past 7 days of fee data, never as backtested", () => {
    const files = [
      "src/components/landing-page.tsx",
      "src/components/homepage-market.tsx",
      "src/components/homepage-pools-table.tsx",
      "src/components/unified-pools/pool-results.tsx",
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
