import { DOCS_ROUTES } from "@/lib/public-urls";

export const DOCS_PAGES = [
  {
    href: DOCS_ROUTES.gettingStarted,
    slug: "getting-started",
    label: "Getting started",
    title: "Getting started",
    description: "Who holds your money, how to verify transactions, and how to open your first position.",
  },
  {
    href: DOCS_ROUTES.yieldAndApr,
    slug: "yield-and-apr",
    label: "Yield & APR",
    title: "Yield & APR",
    description: "Where trading-fee yield comes from and how 24h / 7d APR estimates are computed.",
  },
  {
    href: DOCS_ROUTES.risks,
    slug: "risks",
    label: "Risks",
    title: "Risks",
    description: "Ways you can lose money, and risks SoFinance cannot control.",
  },
  {
    href: DOCS_ROUTES.fees,
    slug: "fees",
    label: "Fees",
    title: "Fees",
    description: "Protocol fee (10 bps of the deposited token), network fees, and what is free.",
  },
  {
    href: DOCS_ROUTES.withdraw,
    slug: "withdraw",
    label: "Withdraw anytime",
    title: "Withdraw anytime",
    description: "How withdrawal works, what you receive, and managing the position without SoFinance.",
  },
  {
    href: DOCS_ROUTES.security,
    slug: "security",
    label: "Security & non-custodial",
    title: "Security & non-custodial",
    description: "Your wallet signs every transaction. Positions stay as standard Raydium CLMM NFTs.",
  },
] as const;

export type DocsPage = (typeof DOCS_PAGES)[number];

export function docsPageByHref(pathname: string): DocsPage | undefined {
  if (pathname === DOCS_ROUTES.gettingStarted || pathname === `${DOCS_ROUTES.gettingStarted}/`) {
    return DOCS_PAGES[0];
  }
  return DOCS_PAGES.find((page) => page.href !== DOCS_ROUTES.gettingStarted && pathname.startsWith(page.href));
}
