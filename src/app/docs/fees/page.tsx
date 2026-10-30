import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES } from "@/lib/public-urls";
import { docsPageMetadata } from "@/lib/seo";

export const metadata = docsPageMetadata("fees");

export default function DocsFeesPage() {
  return (
    <DocsArticle page={DOCS_PAGES[3]!}>
      <h2>SoFinance protocol fee</h2>
      <p>
        SoFinance charges a{" "}
        <strong className="font-medium text-cream">10 basis point (0.10%)</strong> protocol fee
        in the token you deposit. There is no separate performance fee on compounding or on the trading fees you collect.
      </p>
      <ul>
        <li>Currently a fixed 10 bps; any change will be announced in advance.</li>
        <li>
          Opening a position or adding to a position takes the fee{" "}
          <strong className="font-medium text-cream">in the input token, inside the Jupiter swap</strong>{" "}
          (as Jupiter&apos;s platform fee): 10 bps of the part of your deposit that is swapped. Any
          part deposited directly, without a swap (for example USDC into a USDC pool), is not
          charged. The transaction contains no separate transfer to us and never creates an
          account for the fee wallet. The preview shows the fee in the same token.
        </li>
        <li>
          If the protocol fee wallet has no token account yet for your input token, that token
          is temporarily unavailable as input and no transaction is built; use another token.
          Depositing SOL into a pool that itself contains SOL is not available yet.
        </li>
        <li>
          Compounding takes 10 bps of the harvested tokens being reinvested, in that token.
        </li>
        <li>
          Withdrawing to USDC still collects the 10 bps as a Jupiter conversion fee in USDC.
          The withdraw preview shows it as a conversion fee.
        </li>
        <li>
          If you withdraw as <strong className="font-medium text-cream">original tokens</strong>{" "}
          (the two pool tokens, no swap), the fee is{" "}
          <strong className="font-medium text-cream">0</strong>.
        </li>
        <li>
          The fee is taken inside the same transaction you sign, so you can see it on Solscan.
        </li>
      </ul>

      <h2>Solana network fees</h2>
      <p>
        Your wallet pays the normal Solana network fee in SOL for each transaction you sign. Keep a
        little SOL for fees and account deposits on top of what you invest.
      </p>

      <h2>Other costs in the preview</h2>
      <ul>
        <li>Swap costs: the trading fee of the swap route, plus a small price difference on larger swaps.</li>
        <li>A 0.5% price-protection limit on swaps: if the price moves more than that, the swap fails instead of filling worse.</li>
        <li>
          Small SOL deposits Solana requires to create new accounts. Most come back when you close the
          position; a small one-time setup cost may not. The preview lists each one.
        </li>
      </ul>
      <p>
        Withdrawal timing and what you receive are covered under{" "}
        <Link href={DOCS_ROUTES.withdraw}>Withdraw anytime</Link>.
      </p>
    </DocsArticle>
  );
}
