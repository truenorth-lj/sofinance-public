import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES } from "@/lib/public-urls";

export default function DocsRisksPage() {
  return (
    <DocsArticle page={DOCS_PAGES[2]!}>
      <h2>Can I lose money?</h2>
      <p>Yes. Providing liquidity is not risk-free. Plain examples:</p>
      <ul>
        <li>
          <strong className="font-medium text-cream">Price moves against the pair</strong> — even on
          same-asset wraps, the two tokens can trade at a temporary premium or discount. Your
          inventory mix changes as the pool rebalances.
        </li>
        <li>
          <strong className="font-medium text-cream">Out of range stops earning</strong> — while the
          pool price is outside your ticks, you earn no trading fees from that position until price
          returns or you change range.
        </li>
        <li>
          <strong className="font-medium text-cream">Impermanent loss (IL)</strong> — compared with
          simply holding the tokens, LP can underperform when relative prices move. Fee income may
          or may not offset that.
        </li>
        <li>
          <strong className="font-medium text-cream">Conversion / exit costs</strong> — swapping into
          or out of the pool (including withdrawing to USDC) incurs Jupiter route costs, price
          impact, slippage tolerance, and the SoFinance protocol fee on conversions. See{" "}
          <Link href={DOCS_ROUTES.fees}>Fees</Link>.
        </li>
      </ul>
      <p>
        APR tooltips and pair cards link here and to{" "}
        <Link href={DOCS_ROUTES.yieldAndApr}>Yield &amp; APR</Link> because fee APR estimates ignore
        IL and costs.
      </p>

      <h2>Risks we cannot control</h2>
      <ul>
        <li>
          <strong className="font-medium text-cream">Smart contract risk</strong> — Raydium CLMM,
          Jupiter routing, token programs, and related on-chain programs can have bugs or unexpected
          behavior.
        </li>
        <li>
          <strong className="font-medium text-cream">xStock / issuer controls</strong> — some pool
          tokens use Token-2022 and may retain freeze or other issuer authorities. A freeze can
          block transfers, deposits, or withdrawals even though SoFinance is non-custodial.
        </li>
        <li>
          <strong className="font-medium text-cream">Regional and compliance restrictions</strong> —
          token issuers, venues, or local law may restrict who can hold or trade certain assets.
          That is outside SoFinance&apos;s control.
        </li>
        <li>
          <strong className="font-medium text-cream">Network and oracle/routing conditions</strong> —
          Solana congestion, failed transactions, or poor swap routes can change outcomes versus the
          preview.
        </li>
      </ul>
      <p>
        The create-position UI surfaces Token-2022 and freeze-risk flags when discovery detects them.
        Read them before you sign.
      </p>
    </DocsArticle>
  );
}
