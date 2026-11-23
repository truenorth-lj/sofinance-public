import type { Metadata } from "next";
import type { ReactNode } from "react";
import { InkShell } from "@/components/ink";
import { PageHeader } from "@/components/page-header";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { LEGAL_ROUTES } from "@/lib/public-urls";
import { pageMetadata } from "@/lib/seo";
import { SOCIAL_LINKS } from "@/lib/social-links";

/**
 * DRAFT privacy notice (PR-7). Describes what the code does today; legal wording, retention and contact are LJ's call.
 * Not indexed and not linked from the footer until LJ approves it.
 */
export const metadata: Metadata = {
  ...pageMetadata({
    title: "Privacy Notice (draft)",
    description: "Draft privacy notice for SoFinance: what the website, app and MCP server collect, and which providers process it.",
    path: LEGAL_ROUTES.privacy,
  }),
  robots: { index: false, follow: false },
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="border-t border-white/10 pt-6 first:border-t-0 first:pt-0">
    <h2 id={id} className="text-lg font-semibold tracking-[-0.01em] text-cream">{title}</h2>
    <div className="mt-3 space-y-3 text-sm leading-6 text-smoke [&_a]:text-cream [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-medium [&_strong]:text-cream [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">{children}</div>
  </section>;
}

function ToConfirm({ children }: { children: ReactNode }) {
  return <span className="rounded bg-lemon/15 px-1.5 py-0.5 text-xs font-medium text-lemon">To confirm: {children}</span>;
}

export default function PrivacyPage() {
  return <InkShell>
    <SiteHeader />
    <main id="main">
    <PageHeader title="Privacy Notice" subline="Draft for review. Not yet in effect." />
    <article className="mt-3 space-y-6 rounded-[28px] border border-white/12 bg-char p-6 sm:p-9">
      <div role="note" className="rounded-2xl border border-lemon/30 bg-lemon/10 p-4 text-sm leading-6 text-cream">
        <strong>Draft.</strong> This notice describes how SoFinance handles data today, for review before it is published. Items marked &ldquo;To confirm&rdquo; are open.
      </div>

      <Section id="scope" title="1. What this notice covers">
        <p>This notice covers the SoFinance website at sofinancelab.xyz, its web application, its documentation and its MCP server for AI agents at <code>/api/mcp</code> (together, &ldquo;SoFinance&rdquo;). SoFinance is a self-custodial software interface: you sign every transaction in your own wallet.</p>
      </Section>

      <Section id="not-collected" title="2. What we do not collect">
        <ul>
          <li><strong>No accounts.</strong> There is no sign-up, so we hold no name, email address, phone number or password.</li>
          <li><strong>No keys.</strong> We never receive your private keys or seed phrase, and we never hold your funds.</li>
          <li><strong>No stored MCP tokens or sign links.</strong> The MCP access token and the sign links an AI agent gives you are signed, self-contained strings. We verify them when they are used; we do not keep a copy.</li>
        </ul>
      </Section>

      <Section id="wallet-data" title="3. Wallet addresses and on-chain data">
        <p>Wallet addresses, position NFTs and transactions on Solana and Robinhood Chain are public. To show your positions and prepare transactions, SoFinance reads this public data by wallet address or position address.</p>
        <p>Our database keeps a cache of public on-chain position history (transactions and prices) keyed by the position NFT, not by wallet. It also keeps public pool data. It holds no account or contact data.</p>
      </Section>

      <Section id="web-analytics" title="4. Website and app analytics (PostHog)">
        <p>We use PostHog to understand how the website and app are used. It runs only if your browser does not send a Do Not Track signal.</p>
        <ul>
          <li><strong>What is sent:</strong> page views and a fixed list of product events, such as viewing the pools list, starting and finishing a wallet connection, viewing performance, and starting, completing or failing to open a position, with the pool and pair involved.</li>
          <li><strong>Wallet address:</strong> when you connect a wallet, analytics events are linked to its public address.</li>
          <li><strong>Campaign source:</strong> UTM parameters from the first link you arrived by are kept in your browser and sent with events.</li>
          <li><strong>Network data:</strong> PostHog receives your IP address with each event and derives an approximate location (country and city) from it. <ToConfirm>whether to turn off IP capture and GeoIP for website events</ToConfirm></li>
          <li><strong>Turned off:</strong> automatic click capture, session recording, heatmaps and surveys.</li>
        </ul>
      </Section>

      <Section id="mcp-analytics" title="5. MCP server analytics">
        <p>When an AI agent calls a tool on the SoFinance MCP server in production, our server sends one usage event to PostHog.</p>
        <ul>
          <li><strong>What is sent:</strong> the tool name, whether an old tool name was used, the outcome and a short error code, whether a token was sent, the response status and time, the protocol version, and the pool or position address when the call has one. When an agent opens a position, the transaction signature is sent as well.</li>
          <li><strong>Identifier:</strong> a SHA-256 hash of the wallet address (the token&apos;s wallet, or the wallet the call names). When there is no wallet, a shared anonymous identifier is used.</li>
          <li><strong>Not sent:</strong> tool arguments, tokens, transaction contents, sign links, the raw wallet address or your IP address. PostHog only sees our server&apos;s address. No person profile is created, and location lookup is turned off.</li>
        </ul>
      </Section>

      <Section id="errors" title="6. Error monitoring (Sentry)">
        <p>We use Sentry to find and fix errors in the website, app and API. It receives error reports and a sample of performance traces (10%). Default personal data collection is off, and tokens, keys and similar values are removed before a report is sent. Session replay is off.</p>
      </Section>

      <Section id="hosting" title="7. Hosting and request handling (Vercel)">
        <p>SoFinance is hosted on Vercel. Vercel processes every request, including your IP address and browser details, to serve the site and keep it secure.</p>
        <ul>
          <li>We use the country Vercel derives from your IP address only to decide whether to show a regional notice. That choice is stored in a short-lived cookie, and access is never blocked.</li>
          <li>To limit abuse, some API routes count requests per IP address in server memory for one minute. These counts are not stored.</li>
        </ul>
        <p><ToConfirm>Vercel log retention on our plan</ToConfirm></p>
      </Section>

      <Section id="providers" title="8. Blockchain, data and wallet providers">
        <p>To read on-chain data and build transactions, SoFinance sends public addresses to the Solana and Robinhood Chain RPC providers we use. It also sends public token and pool addresses to market data services such as Jupiter, Raydium, Orca, Meteora, GeckoTerminal and DexScreener.</p>
        <p>Your wallet app (for example Phantom or Solflare) and the wallet connection service we use (Reown AppKit, with its analytics turned off) are run by third parties under their own privacy policies.</p>
      </Section>

      <Section id="storage" title="9. Cookies and browser storage">
        <ul>
          <li><strong>Analytics:</strong> PostHog stores an anonymous identifier in a cookie and in local storage. We also keep your first campaign source in local storage.</li>
          <li><strong>Regional notice:</strong> a one-day cookie records whether to show the notice, and local storage records that you dismissed it.</li>
          <li><strong>App state:</strong> local storage keeps in-progress transaction steps (such as a two-step withdrawal) so that you can resume them, along with the wallet connection state.</li>
        </ul>
      </Section>

      <Section id="retention" title="10. How long data is kept">
        <p>Analytics events are kept in PostHog and error reports in Sentry for the retention period of each service. <ToConfirm>retention periods for PostHog and Sentry</ToConfirm></p>
      </Section>

      <Section id="choices" title="11. Your choices">
        <ul>
          <li>Turn on Do Not Track in your browser to switch off website analytics, or use a content blocker.</li>
          <li>You can browse pools and documentation without connecting a wallet.</li>
          <li>You can ask us to delete the analytics data linked to a wallet address. <ToConfirm>request channel and how a request is verified</ToConfirm></li>
        </ul>
      </Section>

      <Section id="changes" title="12. Changes to this notice">
        <p>We will update this notice when how we handle data changes, and update the date at the top.</p>
      </Section>

      <Section id="contact" title="13. Contact">
        <p>Questions about this notice can be sent to <a href={SOCIAL_LINKS.x.href} target="_blank" rel="noreferrer">SoFinance on X</a>. <ToConfirm>a dedicated privacy contact</ToConfirm></p>
      </Section>
    </article>
    </main>
    <SiteFooter variant="marketing" />
  </InkShell>;
}
