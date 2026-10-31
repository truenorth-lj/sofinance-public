import { DOCS_ROUTES } from "@/lib/public-urls";

/**
 * Public docs pages. `label`/`title`/`description` drive the sidebar and page hero; `metaTitle`/`metaDescription`
 * drive each page's <title>, meta description, canonical and share card (see `docsPageMetadata` in `src/lib/seo.ts`).
 */
export const DOCS_PAGES = [
  {
    href: DOCS_ROUTES.gettingStarted,
    slug: "getting-started",
    label: "Getting started",
    title: "Getting started",
    description: "Who holds your money, how to verify transactions, and how to open your first position.",
    metaTitle: "Docs: getting started with same-stock LP",
    metaDescription:
      "Start here: who holds your funds, how to verify a transaction on an explorer, and how to open your first same-stock liquidity position with one signature.",
  },
  {
    href: DOCS_ROUTES.feeApr,
    slug: "fee-apr",
    label: "Fee APR",
    title: "Fee APR",
    description: "Where trading fees come from and how 24h / 7d fee APR estimates are computed.",
    metaTitle: "Fee APR estimates: how LP trading fees are estimated",
    metaDescription:
      "Where liquidity providers' trading fees come from, how SoFinance computes 24h and 7-day fee APR estimates, and why an estimate is not a promised return.",
  },
  {
    href: DOCS_ROUTES.risks,
    slug: "risks",
    label: "Risks",
    title: "Risks",
    description: "Ways you can lose money, and risks SoFinance cannot control.",
    metaTitle: "Risks of providing liquidity with tokenized stocks",
    metaDescription:
      "Ways an LP position can lose money: price moves, out-of-range periods, impermanent loss, smart contract and network risk.",
  },
  {
    href: DOCS_ROUTES.fees,
    slug: "fees",
    label: "Fees",
    title: "Fees",
    description: "Protocol fee (10 bps, only when a swap is made for you), network fees, and what is free.",
    metaTitle: "Fees: 10 bps protocol fee and network costs",
    metaDescription:
      "SoFinance's 10 basis point protocol fee, network fees, swap costs and refundable account deposits, and which actions cost no SoFinance fee at all.",
  },
  {
    href: DOCS_ROUTES.withdraw,
    slug: "withdraw",
    label: "Withdraw anytime",
    title: "Withdraw anytime",
    description: "How withdrawal works, what you receive, and managing the position without SoFinance.",
    metaTitle: "Withdraw anytime: exit an LP position",
    metaDescription:
      "How withdrawing works, what you can receive, one- or two-step exits, and how to manage your position NFT directly on the DEX without SoFinance.",
  },
  {
    href: DOCS_ROUTES.security,
    slug: "security",
    label: "Security & non-custodial",
    title: "Security & non-custodial",
    description: "Your wallet signs every transaction. Positions stay as standard Raydium CLMM NFTs.",
    metaTitle: "Security and self-custody",
    metaDescription:
      "SoFinance never holds your keys or funds: your wallet signs every transaction, and positions stay standard position NFTs you can verify and move.",
  },
] as const;

export type DocsPage = (typeof DOCS_PAGES)[number];
export type DocsSlug = DocsPage["slug"];

export function docsPageBySlug(slug: DocsSlug): DocsPage {
  return DOCS_PAGES.find((page) => page.slug === slug)!;
}

export function docsPageByHref(pathname: string): DocsPage | undefined {
  if (pathname === DOCS_ROUTES.gettingStarted || pathname === `${DOCS_ROUTES.gettingStarted}/`) {
    return DOCS_PAGES[0];
  }
  return DOCS_PAGES.find((page) => page.href !== DOCS_ROUTES.gettingStarted && pathname.startsWith(page.href));
}
