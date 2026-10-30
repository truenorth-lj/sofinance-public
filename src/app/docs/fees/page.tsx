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
        <strong className="font-medium text-cream">10 basis point (0.10%)</strong> protocol fee, only
        when a swap is made for you. There is no separate performance fee on compounding or on the trading fees you collect.
        The preview shows the fee before you sign, and it is taken inside the same transaction.
      </p>

      <h3>On Solana</h3>
      <ul>
        <li>
          Opening a position or adding to a position: 10 bps of the part of your deposit that is
          swapped, in the token you deposit. Any part deposited directly, without a swap (for
          example USDC into a USDC pool), is not charged.
        </li>
        <li>
          Compounding: 10 bps of the harvested tokens that are swapped to rebalance the position, in
          that token. If no swap is needed, there is no fee.
        </li>
        <li>
          Withdrawing to USDC or to another single token: 10 bps of the tokens that are converted.
          The withdraw preview shows it as a conversion fee.
        </li>
        <li>
          Withdrawing as <strong className="font-medium text-cream">original tokens</strong>{" "}
          (the two pool tokens, no swap): the fee is{" "}
          <strong className="font-medium text-cream">0</strong>.
        </li>
      </ul>

      <h3>On Robinhood Chain</h3>
      <ul>
        <li>
          Opening a position: 10 bps of the tokens the swap returns, when part of your deposit is
          swapped into the other pool token. If your range needs only the token you deposit, there
          is no swap and no fee.
        </li>
        <li>
          Closing a position: the fee is <strong className="font-medium text-cream">0</strong>. You
          receive the two pool tokens; there is no option to convert them to USDC.
        </li>
      </ul>

      <h2>Network fees</h2>
      <p>
        Your wallet pays the normal network fee for each transaction you sign: SOL on Solana, ETH on
        Robinhood Chain. Keep a little SOL for fees and account deposits, or a little ETH for gas, on
        top of what you invest.
      </p>

      <h2>Other costs in the preview</h2>
      <ul>
        <li>Swap costs: the trading fee of the swap route, plus a small price difference on larger swaps.</li>
        <li>A price-protection limit on swaps (0.5% on Solana, 0.05% on Robinhood Chain): if the price moves more than that, the swap fails instead of filling worse.</li>
        <li>
          On Solana, small SOL deposits Solana requires to create new accounts. Most come back when you close the
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
