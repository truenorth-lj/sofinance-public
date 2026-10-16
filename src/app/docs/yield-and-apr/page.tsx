import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES } from "@/lib/public-urls";

export default function DocsYieldAndAprPage() {
  return (
    <DocsArticle page={DOCS_PAGES[1]!}>
      <h2>Where does yield come from?</h2>
      <p>
        SoFinance helps you provide liquidity on Raydium pools in a price range you choose — especially
        same-asset xStock-style pairs (wrapped vs unwrapped). When traders swap that pair, the pool
        collects <strong className="font-medium text-cream">trading fees</strong>. Your in-range
        position earns a share of those fees.
      </p>
      <p>
        This is not staking rewards from SoFinance and not interest paid by the site. If the market
        price moves outside your chosen range, your position stops earning trading fees until
        price returns (or you re-range). See <Link href={DOCS_ROUTES.risks}>Risks</Link>.
      </p>

      <h2>How APR is computed</h2>
      <p>The App shows several related estimates. None of them is a guaranteed return.</p>
      <ul>
        <li>
          <strong className="font-medium text-cream">Pool fee APR · 24h</strong> — based on the last
          24 hours of pool fees ÷ TVL, annualized. Labeled as a gross fee figure before Raydium&apos;s
          protocol cut on fees.
        </li>
        <li>
          <strong className="font-medium text-cream">Highest range APR · 7d avg</strong> — estimated
          from recent trading volume and fees, for a sample deposit (about $100) in a candidate
          range (Micro / Tight / Standard / Wide). Not guaranteed.
        </li>
        <li>
          <strong className="font-medium text-cream">Est. fee APR</strong> on the create-position
          flow uses the last 7 full days of trading volume and how much liquidity sits near each price today. It assumes recent volume/price behavior continues, counts fees only while price is
          inside the range, and ignores impermanent loss and your trading costs.
        </li>
      </ul>
      <p>
        A simple published pool estimate also appears as{" "}
        <code className="rounded-md bg-white/10 px-1.5 py-0.5 font-data text-xs text-cream/90">
          (24h fees ÷ TVL) × 365 × 100
        </code>
        . That is a pool-level fee APR label, not your personal LP return.
      </p>

      <h2>What APR does not mean</h2>
      <ul>
        <li>It is an estimate from recent data, not a promise.</li>
        <li>Narrower ranges often show higher estimated APR and leave range sooner.</li>
        <li>Larger deposits in the same range typically earn a lower rate than the $100 reference.</li>
        <li>Your realized result also depends on price path, swaps, and fees — see{" "}
          <Link href={DOCS_ROUTES.fees}>Fees</Link>.</li>
      </ul>
    </DocsArticle>
  );
}
