import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS } from "@/lib/social-links";
import { docsPageMetadata } from "@/lib/seo";

export const metadata = docsPageMetadata("security");

const EXAMPLE_TX =
  "https://solscan.io/tx/3YkXwPpSotg8pJEv4XAFYWrU71kY8Wf8U7iHZunve8E7J5b26hbynwXV3tWm9X1WCh4m6FaeFhb1RXTXwQoTev3t";

export default function DocsSecurityPage() {
  return (
    <DocsArticle page={DOCS_PAGES[5]!}>
      <h2>Non-custodial by design</h2>
      <p>
        SoFinance does not hold your private keys and does not take custody of your tokens. An AI
        assistant or our server can prepare a transaction for you, but only your wallet can approve it.
      </p>
      <ul>
        <li>Funds and the position NFT remain in your wallet.</li>
        <li>Every mutating flow requires your signature.</li>
        <li>
          Before sending, we simulate the transaction again to make sure the result matches what you saw.
        </li>
      </ul>

      <h2>Verify on Solscan</h2>
      <p>
        Token movements are on-chain. Paste any signature into{" "}
        <a href="https://solscan.io" {...EXTERNAL_LINK_PROPS}>
          Solscan
        </a>{" "}
        to confirm what moved. Example transaction (illustration only):{" "}
        <a href={EXAMPLE_TX} {...EXTERNAL_LINK_PROPS}>
          example transaction
        </a>
        .
      </p>

      <h2>Position NFT portability</h2>
      <p>
        Opening a position puts a Raydium position NFT in your wallet. If this site went
        offline, you could still withdraw or manage that NFT through Raydium. Details:{" "}
        <Link href={DOCS_ROUTES.withdraw}>Withdraw anytime</Link>.
      </p>

      <h2>What this does not remove</h2>
      <p>
        Non-custodial does not mean risk-free. Smart contracts, issuer freeze authority, Token-2022
        features, and market risk still apply — see <Link href={DOCS_ROUTES.risks}>Risks</Link>.
      </p>

      <h2>Try it yourself</h2>
      <p>
        SoFinance is a hackathon-born toolkit with a live deployment.
        Use the <Link href={APP_ROUTES.home}>App</Link> yourself, or{" "}
        <Link href={APP_ROUTES.ai}>Use AI</Link> to let an assistant prepare transactions you approve. Start from{" "}
        <Link href={DOCS_ROUTES.gettingStarted}>Getting started</Link> if you are new.
      </p>
    </DocsArticle>
  );
}
