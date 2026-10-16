import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS } from "@/lib/social-links";

export default function DocsWithdrawPage() {
  return (
    <DocsArticle page={DOCS_PAGES[4]!}>
      <h2>Withdraw anytime</h2>
      <p>
        You can reduce or close a position from the App whenever you want. There is no lockup period
        imposed by SoFinance. How long it takes is mostly Solana confirmation time — usually seconds
        to a short wait for finality — plus any second step if conversion needs a follow-up
        transaction.
      </p>

      <h2>What do I receive?</h2>
      <p>You choose the receive mode in the withdraw panel:</p>
      <ul>
        <li>
          <strong className="font-medium text-cream">USDC</strong> (default) — pool tokens (and
          fees as applicable) are swapped toward USDC.
        </li>
        <li>
          <strong className="font-medium text-cream">SOL</strong> or a specific pool mint — convert
          toward that mint when routing allows.
        </li>
        <li>
          <strong className="font-medium text-cream">Original tokens</strong> — you receive the two
          pool tokens without a SoFinance conversion swap (protocol conversion fee is 0).
        </li>
      </ul>
      <p>
        Closing 100% also closes the Raydium position and returns recoverable position account
        deposits in SOL when those accounts close.
      </p>

      <h2>One transaction or two?</h2>
      <p>
        When exit + conversion fit in a single v0 transaction, withdraw runs as{" "}
        <strong className="font-medium text-cream">one atomic transaction</strong>. If the combined
        message would exceed Solana&apos;s size limit, the App splits into{" "}
        <strong className="font-medium text-cream">two steps</strong>: first withdraw the tokens to
        your wallet, then a second signed transaction to convert. The preview tells you which path
        applies before you sign.
      </p>
      <p>
        Conversion fees and network fees still apply as described in{" "}
        <Link href={DOCS_ROUTES.fees}>Fees</Link>. High price impact may ask for an extra
        confirmation.
      </p>

      <h2>If SoFinance disappears</h2>
      <p>
        Your position is a <strong className="font-medium text-cream">standard Raydium CLMM
        position NFT</strong> in your wallet. You can manage or withdraw liquidity on Raydium (or
        any compatible tool) without SoFinance. The site is a builder and broadcast helper, not a
        custodian.
      </p>
      <p>
        Raydium:{" "}
        <a href="https://raydium.io" {...EXTERNAL_LINK_PROPS}>
          raydium.io
        </a>
        . More on custody: <Link href={DOCS_ROUTES.security}>Security &amp; non-custodial</Link>.
      </p>
    </DocsArticle>
  );
}
