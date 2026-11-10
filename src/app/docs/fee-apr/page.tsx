import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES } from "@/lib/public-urls";
import { docsPageMetadata } from "@/lib/seo";

export const metadata = docsPageMetadata("fee-apr");

export default function DocsFeeAprPage() {
  return (
    <DocsArticle page={DOCS_PAGES[1]!}>
      <h2>Where do trading fees come from?</h2>
      <p>
        SoFinance helps you provide liquidity on Raydium pools in a price range you choose — especially
        same-asset xStock-style pairs (wrapped vs unwrapped). When traders swap that pair, the pool
        collects <strong className="font-medium text-cream">trading fees</strong>. While it is in
        range, your position collects a share of those fees.
      </p>
      <p>
        This is not staking rewards from SoFinance and not interest paid by the site. If the market
        price moves outside your chosen range, your position collects no trading fees until
        price returns (or you re-range). See <Link href={DOCS_ROUTES.risks}>Risks</Link>.
      </p>

      <h2>How fee APR is computed</h2>
      <p>The App shows several related estimates. None of them is a prediction of your return.</p>
      <ul>
        <li>
          <strong className="font-medium text-cream">Range APR · 7d</strong> on the pool cards — estimated
          from recent trading volume and fees, for a $1,000 deposit in the best candidate range (Micro / Tight /
          Standard / Wide). Not a prediction.
        </li>
        <li>
          <strong className="font-medium text-cream">Est. fee APR</strong> on the Solana
          create-position flow is picked from the past 7 days of fee data: it uses the last 7 full days of trading volume and how much liquidity sits near each price today. It assumes recent volume/price behavior continues, counts fees only while price is
          inside the range, and ignores impermanent loss and your trading costs.
        </li>
      </ul>
      <p>
        The pools list shows one APR per pool: the 7-day estimate. Single-day figures swing too much to
        compare pools, so they are not shown.
      </p>

      <h2>What fee APR does not mean</h2>
      <ul>
        <li>It is an estimate from recent data, not a promise.</li>
        <li>Narrower ranges often show higher estimated APR and leave range sooner.</li>
        <li>Larger deposits in the same range typically collect fees at a lower rate than the ~$100 reference the
          create-position estimate starts from.</li>
        <li>Your realized result also depends on price path, swaps, and fees — see{" "}
          <Link href={DOCS_ROUTES.fees}>Fees</Link>.</li>
      </ul>
    </DocsArticle>
  );
}
