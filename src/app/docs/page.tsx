import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS } from "@/lib/social-links";
import { docsPageMetadata } from "@/lib/seo";

export const metadata = docsPageMetadata("getting-started");

const EXAMPLE_TX =
  "https://solscan.io/tx/3YkXwPpSotg8pJEv4XAFYWrU71kY8Wf8U7iHZunve8E7J5b26hbynwXV3tWm9X1WCh4m6FaeFhb1RXTXwQoTev3t";

export default function DocsGettingStartedPage() {
  return (
    <DocsArticle page={DOCS_PAGES[0]!}>
      <h2>Who holds your money?</h2>
      <p>
        You do. SoFinance never takes custody of your tokens or private keys. Your funds stay in{" "}
        <strong className="font-medium text-cream">your own Solana wallet</strong>. Every on-chain
        action — opening a position, compounding, withdrawing — is an unsigned transaction that only
        becomes valid when <strong className="font-medium text-cream">you sign it</strong> in that
        wallet.
      </p>
      <p>
        A Raydium liquidity position is represented by a standard position NFT that lands in your wallet.
        SoFinance builds and simulates the transaction; your wallet approves it. See{" "}
        <Link href={DOCS_ROUTES.security}>Security &amp; non-custodial</Link> for the full model.
      </p>

      <h2>How to verify a transaction</h2>
      <p>
        After you sign and the network confirms, every transfer is public on Solana. Open the
        signature on{" "}
        <a href="https://solscan.io" {...EXTERNAL_LINK_PROPS}>
          Solscan
        </a>{" "}
        (or any Solana explorer) to inspect accounts, token movements, and program calls.
      </p>
      <p>
        Example transaction (for illustration only — not a live deposit of yours):{" "}
        <a href={EXAMPLE_TX} {...EXTERNAL_LINK_PROPS}>
          example transaction
        </a>
        .
      </p>

      <h2>Open your first position</h2>
      <ol>
        <li>
          Connect a Solana wallet on the{" "}
          <Link href={APP_ROUTES.home}>App</Link>.
        </li>
        <li>
          Browse same-asset RWA pairs on{" "}
          <Link href={APP_ROUTES.rwaPairs}>RWA pairs</Link>, or pick an existing position under
          Positions.
        </li>
        <li>
          Review the quote, estimated fees, and range. Read{" "}
          <Link href={DOCS_ROUTES.risks}>Risks</Link> before you confirm.
        </li>
        <li>Approve once in your wallet. Before sending, we simulate the transaction again to make sure the result matches what you saw.</li>
      </ol>
      <p>
        Fee APR figures in the App are estimates — see{" "}
        <Link href={DOCS_ROUTES.feeApr}>Fee APR</Link>. Fee rules are on{" "}
        <Link href={DOCS_ROUTES.fees}>Fees</Link>. You can leave anytime —{" "}
        <Link href={DOCS_ROUTES.withdraw}>Withdraw anytime</Link>.
      </p>

      <h2>Who we are</h2>
      <p>
        SoFinance is a non-custodial LP toolkit, started for the Colosseum hackathon track. Whether you use the App or an AI assistant, the same checks apply: preview,
        your signature, a final check, then send.
      </p>
      <ul>
        <li>
          Live app:{" "}
          <a href="https://sofinancelab.xyz" {...EXTERNAL_LINK_PROPS}>
            sofinancelab.xyz
          </a>
        </li>
        <li>
          Colosseum project:{" "}
          <a href="https://colosseum.com/arena/projects/16410" {...EXTERNAL_LINK_PROPS}>
            project 16410
          </a>
        </li>
        <li>
          Follow us on X:{" "}
          <a href="https://x.com/SoFinancelab" {...EXTERNAL_LINK_PROPS}>
            @SoFinancelab
          </a>
        </li>
      </ul>
      <p>
        Transactions you sign are verifiable on Solscan. SoFinance does not hold keys and does not
        custody your position NFT.
      </p>
    </DocsArticle>
  );
}
