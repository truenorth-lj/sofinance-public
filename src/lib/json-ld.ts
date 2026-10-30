import { CANONICAL_SITE_URL } from "@/lib/public-urls";
import { SOCIAL_LINKS } from "@/lib/social-links";

export type JsonLd = Record<string, unknown>;

export const ORGANIZATION_ID = `${CANONICAL_SITE_URL}/#organization`;
export const WEBSITE_ID = `${CANONICAL_SITE_URL}/#website`;

/** One Organization node (same @id everywhere, so search engines merge the blog's and the homepage's). */
export function organizationJsonLd(): JsonLd {
  return {
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: "SoFinance",
    url: CANONICAL_SITE_URL,
    logo: `${CANONICAL_SITE_URL}/icon-512.png`,
    sameAs: [SOCIAL_LINKS.x.href],
  };
}

/** Homepage graph: Organization + WebSite. */
export function homeJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationJsonLd(),
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: CANONICAL_SITE_URL,
        name: "SoFinance",
        description:
          "Self-custodial tool for providing liquidity to same-stock pools of tokenized stocks and collecting trading fees, on Solana and Robinhood Chain.",
        inLanguage: "en",
        publisher: { "@id": ORGANIZATION_ID },
      },
    ],
  };
}

/** Safe to drop into a <script type="application/ld+json"> body. */
export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
