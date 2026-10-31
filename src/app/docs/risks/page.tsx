import Link from "next/link";
import { DocsArticle } from "@/components/docs/docs-article";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES } from "@/lib/public-urls";
import { docsPageMetadata } from "@/lib/seo";

export const metadata = docsPageMetadata("risks");

export default function DocsRisksPage() {
  return (
    <DocsArticle page={DOCS_PAGES[2]!}>
      <h2>Can I lose money?</h2>
      <p>Yes. Providing liquidity is not risk-free. Plain examples:</p>
      <ul>
        <li>
          <strong className="font-medium text-cream">Price moves against the pair</strong> — even on
          same-asset wraps, the two tokens can trade at a temporary premium or discount. The mix of the two tokens in your position shifts as the price moves.
        </li>
        <li>
          <strong className="font-medium text-cream">Out of range collects no fees</strong> — while the
          pool price is outside your range, that position collects no trading fees until price
          returns or you change range.
        </li>
        <li>
          <strong className="font-medium text-cream">Impermanent loss (IL)</strong> — compared with
          simply holding the tokens, LP can underperform when relative prices move. Fee income may
          or may not offset that.
        </li>
        <li>
          <strong className="font-medium text-cream">Conversion / exit costs</strong> — swapping into
          or out of the pool (including withdrawing to USDC) costs swap fees, some price difference on larger amounts, and the SoFinance 10 bps protocol fee on the deposited or converted amount. There is no extra performance fee on the trading fees you collect. See{" "}
          <Link href={DOCS_ROUTES.fees}>Fees</Link>.
        </li>
      </ul>
      <p>
        APR tooltips and pair cards link here and to{" "}
        <Link href={DOCS_ROUTES.feeApr}>Fee APR</Link> because fee APR estimates ignore
        IL and costs.
      </p>

      <h2>Risks we cannot control</h2>
      <ul>
        <li>
          <strong className="font-medium text-cream">Smart contract risk</strong> — Raydium, the Jupiter swap router, token programs, and related on-chain programs can have bugs or unexpected
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
          <strong className="font-medium text-cream">Network conditions</strong> —
          A busy Solana network or poor swap prices can make the result differ from the preview.
        </li>
      </ul>

      <h2 id="robinhood-chain">Robinhood Chain pools</h2>
      <p>
        Pools on Robinhood Chain (chain ID 4663) work differently from Solana pools. What is specific to them:
      </p>
      <ul>
        <li>
          <strong className="font-medium text-cream">What you hold</strong> — each position is a standard
          Uniswap v4 position NFT, minted by the Uniswap v4 PositionManager to your own wallet. Whoever holds the
          NFT controls the position, so moving it or losing access to your wallet means losing the position.
        </li>
        <li>
          <strong className="font-medium text-cream">The pair</strong> — each pool pairs a Robinhood token with
          an Ondo token. They come from different issuers and can trade at a premium or discount to each other.
        </li>
        <li>
          <strong className="font-medium text-cream">Dynamic fee</strong> — pools use the StablePairHook, which
          sets the trading fee on each swap. Fees you earn later can differ from what any estimate shows. The
          7-day backtest in the create-position flow is Solana-only; see{" "}
          <Link href={DOCS_ROUTES.feeApr}>Fee APR</Link>.
        </li>
        <li>
          <strong className="font-medium text-cream">Upgradeable hook</strong> — the hook contract can be
          upgraded. The admin role that controls upgrades is held by a single externally owned wallet, not a
          multisig contract. If the hook&apos;s code or a pool&apos;s fee settings change from the version SoFinance
          checked, SoFinance stops offering new positions in that pool. Closing an existing position stays
          available.
        </li>
        <li>
          <strong className="font-medium text-cream">Hook and closing</strong> — the hook runs when a pool is set
          up, when liquidity is added and on swaps. It has no permission to run when liquidity is removed. In
          Uniswap v4 those permissions are fixed by the hook&apos;s address, so an upgrade cannot add them.
        </li>
        <li>
          <strong className="font-medium text-cream">Smart contract risk</strong> — Uniswap v4 (PoolManager,
          PositionManager, Permit2), the hook and the token contracts can have bugs or unexpected behavior.
        </li>
        <li>
          <strong className="font-medium text-cream">Approvals and signatures</strong> — opening takes a Permit2
          signature and one transaction. The first time you deposit a token, your wallet also approves Permit2 for
          that token: a one-time, unlimited approval. Each open still needs its own signature for the exact
          amount.
        </li>
        <li>
          <strong className="font-medium text-cream">Costs and price limits</strong> — when part of your deposit
          is swapped into the other pool token, SoFinance charges 10 bps of the tokens the swap returns. Closing is
          one transaction with no SoFinance fee and returns both pool tokens, with no USDC option. Network fees
          are paid in ETH. If the price moves past the price-protection limit before your transaction lands, the
          transaction fails. See <Link href={DOCS_ROUTES.fees}>Fees</Link>.
        </li>
        <li>
          <strong className="font-medium text-cream">Token issuers</strong> — Robinhood and Ondo tokens are
          issued by their respective issuers. For what an issuer can do with its token, see issuer terms.
        </li>
        <li>
          <strong className="font-medium text-cream">Checking on chain</strong> — your position and every
          transaction can be looked up on the Robinhood Chain explorer at robinhoodchain.blockscout.com.
        </li>
      </ul>
    </DocsArticle>
  );
}
