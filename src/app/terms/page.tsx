import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { InkHero, InkNav, InkShell } from "@/components/ink";
import { DOCS_ROUTES } from "@/lib/public-urls";
import { SOCIAL_LINKS } from "@/lib/social-links";
import { TERMS_JURISDICTION_EN, TERMS_LAST_UPDATED } from "@/lib/terms-content";

export const metadata: Metadata = {
  title: "Terms of Service · SoFinance",
  description: "Terms of Service for SoFinance, a self-custodial software interface for Raydium CLMM positions on Solana.",
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="border-t border-white/10 pt-6 first:border-t-0 first:pt-0">
    <h2 id={id} className="text-lg font-semibold tracking-[-0.01em] text-cream">{title}</h2>
    <div className="mt-3 space-y-3 text-sm leading-6 text-smoke [&_a]:text-cream [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-medium [&_strong]:text-cream [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">{children}</div>
  </section>;
}

export default function TermsPage() {
  return <InkShell>
    <InkNav />
    <InkHero label="Legal" title="Terms of Service">Last updated {TERMS_LAST_UPDATED}</InkHero>
    <article className="mt-3 space-y-6 rounded-[28px] border border-white/12 bg-char p-6 sm:p-9">
      <Section id="acceptance" title="1. Acceptance of these Terms">
        <p>These Terms of Service (the &ldquo;Terms&rdquo;) govern your access to and use of the SoFinance website at sofinancelab.xyz, its web application, its documentation and its MCP server for AI agents (together, &ldquo;SoFinance&rdquo; or the &ldquo;Interface&rdquo;). By accessing the Interface or connecting a wallet to it, you agree to these Terms. If you do not agree, do not use SoFinance.</p>
      </Section>

      <Section id="what-it-is" title="2. What SoFinance is">
        <p>SoFinance is a <strong>self-custodial software interface</strong> for interacting with Raydium concentrated-liquidity (CLMM) pools on the Solana blockchain. It helps you prepare transactions to open, add to, compound and withdraw Raydium CLMM positions. Every transaction is built for you to review and is signed by you in your own wallet, and every transaction can be verified on a public block explorer such as Solscan.</p>
        <ul>
          <li><strong>We do not take custody of your assets.</strong> SoFinance never holds your private keys and never receives, holds or controls your funds. Your assets stay in your wallet or in on-chain smart contracts that you interact with directly.</li>
          <li><strong>We do not issue any token.</strong> SoFinance has no token of its own.</li>
          <li><strong>Tokenized stocks are issued by third parties.</strong> xStocks and other tokenized stock or real-world-asset tokens shown in the Interface are issued by third parties, not by SoFinance. We do not issue, sell, redeem or guarantee them.</li>
          <li>SoFinance is not a broker, dealer, exchange, custodian, bank, fund or investment adviser, and it does not operate the Raydium protocol, Jupiter, the Solana network or any token.</li>
        </ul>
      </Section>

      <Section id="eligibility" title="3. Eligibility and applicable law">
        <p>You must be at least 18 years old and legally able to enter into these Terms.</p>
        <p>{TERMS_JURISDICTION_EN}</p>
        <p>You may not use SoFinance if you are, or act on behalf of, a person or entity that is subject to sanctions administered by the United Nations, the United States, the European Union, the United Kingdom or any other applicable authority.</p>
      </Section>

      <Section id="no-advice" title="4. No investment, legal or tax advice">
        <p>Nothing in the Interface, the documentation or any output of the MCP server is investment, financial, legal, tax or other professional advice, or a recommendation or solicitation to buy, sell or hold any asset or to provide liquidity. You decide whether a transaction is right for you. Consult your own advisers.</p>
      </Section>

      <Section id="risks" title="5. Risks">
        <p>Providing liquidity and holding digital assets is risky and you can lose some or all of the value you put in. Risks include, without limitation:</p>
        <ul>
          <li><strong>Impermanent loss.</strong> When the relative price of the two tokens in a pool changes, the value of your position can be lower than if you had simply held the tokens.</li>
          <li><strong>Out-of-range positions earn no fees.</strong> A concentrated-liquidity position only earns trading fees while the pool price is inside the position&rsquo;s price range. When the price moves outside the range, the position earns no fees and is held entirely in one of the two tokens.</li>
          <li><strong>Smart-contract and software risk.</strong> Raydium, Jupiter, token programs, the Solana network and SoFinance&rsquo;s own software may contain bugs, be exploited, be upgraded or stop working, which can cause loss of funds or failed transactions.</li>
          <li><strong>Tokenized-stock risk.</strong> Tokenized stocks depend on their third-party issuer and its custodians. They may not track the underlying share price, may lack shareholder rights, may be paused, frozen, restricted or redeemed by the issuer, may trade while the underlying market is closed, and may be affected by legal or regulatory changes.</li>
          <li><strong>Market and execution risk.</strong> Prices can move quickly. Swaps can suffer price impact and slippage, and transactions can fail or land at a different price than the preview.</li>
          <li><strong>APR figures are estimates.</strong> APR and return figures shown by SoFinance are estimates based on past on-chain data and stated assumptions. They are not guaranteed and are not a forecast of future returns.</li>
        </ul>
        <p>See also the <Link href={DOCS_ROUTES.risks}>Risks</Link> documentation.</p>
      </Section>

      <Section id="fees" title="6. Fees">
        <ul>
          <li>SoFinance charges a protocol fee of <strong>10 basis points (0.10%)</strong> on the amount swapped when a flow swaps one token into another: when opening a position, when withdrawing or converting to another token, and when compounding. The fee is included in the transaction you sign and is shown in the preview.</li>
          <li>Withdrawing as the two original pool tokens involves no swap and no SoFinance fee.</li>
          <li><strong>You pay Solana network fees</strong> and any account rent deposits required by the network, as well as third-party costs such as pool trading fees and swap-route costs.</li>
          <li>We may change the fee. Any change will be announced in advance and shown in the transaction preview.</li>
        </ul>
        <p>See the <Link href={DOCS_ROUTES.fees}>Fees</Link> documentation for details.</p>
      </Section>

      <Section id="positions" title="7. Your positions">
        <p>Positions opened through SoFinance are standard <strong>Raydium CLMM position NFTs</strong> held in your own wallet. SoFinance has no special control over them. You can view, manage and withdraw them directly on Raydium or with any other compatible tool, without using SoFinance. See <Link href={DOCS_ROUTES.withdraw}>Withdraw anytime</Link>.</p>
      </Section>

      <Section id="your-responsibilities" title="8. Your responsibilities">
        <ul>
          <li>You are solely responsible for your wallet, private keys and seed phrase, and for every transaction you sign, including transactions prepared for you by an AI agent through the MCP server.</li>
          <li>Review each transaction preview before signing. A signed transaction on Solana generally cannot be reversed.</li>
          <li>You must not use SoFinance for unlawful purposes, to launder money or evade sanctions, to manipulate markets, or to interfere with or attack the Interface or its infrastructure.</li>
        </ul>
      </Section>

      <Section id="as-is" title="9. Provided “as is”">
        <p>SoFinance is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>, without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, accuracy, availability and non-infringement. We do not warrant that the Interface, its data, its estimates or any third-party protocol will be accurate, secure, uninterrupted or error-free. We may change, suspend or discontinue any part of SoFinance at any time.</p>
      </Section>

      <Section id="liability" title="10. Limitation of liability">
        <p>To the maximum extent permitted by law, SoFinance and its contributors, operators and affiliates will not be liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of profits, revenue, data, digital assets or goodwill, arising out of or related to your use of, or inability to use, SoFinance or any third-party protocol, token or network, even if advised of the possibility of such damages. To the maximum extent permitted by law, our total liability for any claim relating to SoFinance will not exceed the greater of the SoFinance protocol fees you paid in the three months before the claim and USD 100.</p>
        <p>You agree to indemnify and hold harmless SoFinance and its contributors and operators from claims arising out of your use of SoFinance or your breach of these Terms.</p>
      </Section>

      <Section id="third-parties" title="11. Third-party services">
        <p>SoFinance interacts with third-party protocols, tokens, wallets, data providers and RPC services (for example Raydium, Jupiter, token issuers and Solana infrastructure providers). We do not control them and are not responsible for them. Your use of them may be subject to their own terms.</p>
      </Section>

      <Section id="changes" title="12. Changes to these Terms">
        <p>We may update these Terms from time to time. The &ldquo;Last updated&rdquo; date above shows when they last changed. Material changes may require you to accept the Terms again before connecting a wallet. Continuing to use SoFinance after a change means you accept the updated Terms.</p>
      </Section>

      <Section id="contact" title="13. Contact">
        <p>Questions about these Terms can be sent to <a href={SOCIAL_LINKS.x.href} target="_blank" rel="noreferrer">SoFinance on X</a>.</p>
      </Section>
    </article>
  </InkShell>;
}
