import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES } from "@/lib/public-urls";

export default function DocsFeesPage() {
  return (
    <DocsArticle page={DOCS_PAGES[3]!}>
      <h2>SoFinance protocol fee</h2>
      <p>
        When a flow converts tokens through a swap (open, withdraw-to-USDC/SOL/other mint, or
        compound rebalance), SoFinance may charge a{" "}
        <strong className="font-medium text-cream">10 basis point (0.10%)</strong> protocol fee on
        the converted amount. The same default rate applies on compound when a swap leg is required.
      </p>
      <ul>
        <li>Default: <code className="rounded-md bg-white/10 px-1.5 py-0.5 font-data text-xs">10 bps</code> (configurable up to 100 bps by the operator).</li>
        <li>
          Charged <strong className="font-medium text-cream">on converted tokens only</strong> — the
          withdraw preview labels this as a conversion fee.
        </li>
        <li>
          If you withdraw as <strong className="font-medium text-cream">original tokens</strong>{" "}
          (both pool mints, no conversion), the protocol conversion fee is{" "}
          <strong className="font-medium text-cream">0</strong>.
        </li>
        <li>
          The fee is collected inside the same user-signed transaction to the configured fee wallet.
          If no fee wallet is configured, the protocol fee is 0.
        </li>
      </ul>

      <h2>Solana network fees</h2>
      <p>
        Your wallet pays ordinary Solana network fees in SOL for each transaction you sign (base fee
        plus any priority / tip the flow includes). Keep enough SOL for fees and account rent in
        addition to the assets you invest.
      </p>

      <h2>Other costs in the preview</h2>
      <ul>
        <li>Jupiter route / pool swap fees and price impact when zapping or converting.</li>
        <li>Fixed Jupiter slippage tolerance used by the engine (0.5% on those routes).</li>
        <li>
          Account rent for new token accounts or position accounts — some of it is refundable when
          you close empty accounts / the position; some shared setup may be non-refundable. The open
          preview breaks these out.
        </li>
      </ul>
      <p>
        Withdrawal timing and what you receive are covered under{" "}
        <Link href={DOCS_ROUTES.withdraw}>Withdraw anytime</Link>.
      </p>
    </DocsArticle>
  );
}
