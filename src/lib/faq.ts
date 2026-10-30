import type { JsonLd } from "@/lib/json-ld";

/**
 * Public FAQ (`/faq`), one source for the visible page, its FAQPage JSON-LD and `/llms.txt`, so the structured
 * data always matches what a reader sees. Plain text only (no APR or volume numbers: pools change daily).
 */
export type FaqItem = { question: string; answer: string };
export type FaqSection = { id: string; title: string; items: FaqItem[] };

/** When the pool lists below were last checked against the live pools page. */
export const FAQ_POOLS_AS_OF = "30 October 2026";

export const FAQ_SOLANA_POOLS =
  "SpaceX (SPCX/SPCXx), Strategy (MSTR/MSTRx), Nvidia, Alphabet, Apple, Tesla, Meta, Amazon, Intel, AMD, Broadcom, SanDisk, SK hynix and Robinhood";

export const FAQ_ROBINHOOD_CHAIN_POOLS = "SPCX, NVDA, SPY, META, GOOGL, AAPL, MSTR, CRCL, TSLA, QQQ and GME";

export const FAQ_RISK_LINE =
  "Liquidity providing can lose money. Fee APR figures are estimates from recent windows, not promises. Not investment advice.";

export const FAQ_SECTIONS: readonly FaqSection[] = [
  {
    id: "lp-fees",
    title: "LP and trading fees",
    items: [
      {
        question: "How do liquidity providers collect trading fees?",
        answer:
          "Every swap through a pool pays that pool's fee. Liquidity providers (LPs) deposit two tokens into the pool, and the fees are shared among LPs in proportion to the liquidity they have active at the current price. In concentrated-liquidity pools (Raydium CLMM on Solana, Uniswap v4 on Robinhood Chain) you choose a price range, and your position collects fees only while the pool price is inside that range. On SoFinance you pick a same-stock pool, review the suggested range, and open the position from your own wallet. You can collect, compound or withdraw at any time. Liquidity providing can lose money; see the risks questions below.",
      },
      {
        question: "What happens when the price leaves my LP range?",
        answer:
          "Your position stops collecting trading fees until the price comes back inside your range or you open a new range. Out of range, the position also ends up holding only one of the two tokens. SoFinance does not move your range automatically: you decide whether to wait, re-open with a new range, or withdraw. Narrow ranges show a higher estimated fee APR but leave range more often.",
      },
      {
        question: "Is the fee APR what I will actually get?",
        answer:
          "No. A fee APR is an estimate from recent data, not a promise. The pool figure is (24h pool fees / TVL) x 365, a gross pool-level number. The range estimate shown before you open a Solana position uses the last 7 full days of volume and assumes that pattern continues. Neither includes impermanent loss, swap costs or network fees, and your own result depends on price path, range and deposit size. SoFinance labels the window behind each figure.",
      },
      {
        question: "What is impermanent loss, and does it apply to same-stock pools?",
        answer:
          "Impermanent loss is the gap between holding two tokens and providing them as liquidity: as the relative price moves, the pool shifts your position toward the token that got cheaper. In a same-stock pool such as MSTR/MSTRx both tokens track the same share, so the relative price usually stays near 1:1, but the two issuers' tokens can still trade at a premium or discount to each other. That gap, plus issuer controls and smart contract risk, means LP in a same-stock pool can still lose money compared with holding.",
      },
      {
        question: "What is a same-stock pool, like MSTR/MSTRx or SPCX/SPCXx?",
        answer:
          "It is a pool where both sides are the same underlying stock from two issuers. On Solana that is a Backpack Securities token (for example MSTR) paired with the xStocks token (for example MSTRx) on Raydium. On Robinhood Chain it is a Robinhood stock token paired with the Ondo Global Markets token for the same stock (for example NVDA/NVDAon) on Uniswap v4. Traders swap between the two versions, and each swap pays the pool fee. Because both tokens track the same share, the price stays close to 1:1, which makes tight ranges practical.",
      },
    ],
  },
  {
    id: "tokenized-stocks",
    title: "Tokenized stocks",
    items: [
      {
        question: "What are xStocks?",
        answer:
          "xStocks are tokenized US stocks and ETFs issued by Backed Assets. Each token (for example TSLAx or MSTRx) is backed 1:1 by the underlying share held with a custodian and is issued on Solana as a Token-2022 token. They trade around the clock onchain, can be held in Solana wallets, swapped on DEXs and aggregators, and used in DeFi, including SoFinance's same-stock pools. They are not offered to US persons or in some other jurisdictions.",
      },
      {
        question: "What are Backpack Securities tokenized stocks, and how are they different from xStocks?",
        answer:
          "Backpack Securities lets eligible users buy US shares in a Backpack account and withdraw them to Solana as tokens (for example SPCX, MSTR, TSLA). Each token is redeemable 1:1 for the underlying share by depositing it back into Backpack. xStocks come from a different issuer, Backed, and use the ticker plus x (for example SPCXx). Both track the same share, which is why the two versions can be paired in one pool.",
      },
      {
        question: "Which pools does SoFinance support?",
        answer: `SoFinance lists same-stock pools on two chains. On Solana: Raydium CLMM pools pairing Backpack Securities and xStocks tokens; as of ${FAQ_POOLS_AS_OF} these include ${FAQ_SOLANA_POOLS}, some in more than one fee tier, plus a USDC/USDT pool. On Robinhood Chain: 11 Uniswap v4 pools that use a reviewed StablePairHook and pair a Robinhood stock token with its Ondo Global Markets version, for ${FAQ_ROBINHOOD_CHAIN_POOLS}. The live list, with fee tier, TVL and 24h volume for each pool, is at sofinancelab.xyz/app/rwa-pairs.`,
      },
      {
        question: "Which wallet do I need?",
        answer:
          "For Solana pools, a Solana wallet such as Phantom, Solflare or Backpack. For Robinhood Chain pools, an EVM wallet such as MetaMask connected to Robinhood Chain. You keep the keys in both cases; SoFinance only asks your wallet to sign.",
      },
      {
        question: "What can I do with tokenized stocks sitting idle in my wallet?",
        answer:
          "You can keep holding them, use them as collateral where a lending protocol supports them, or provide liquidity. With SoFinance you can put idle tokens like MSTRx or SPCX into a same-stock pool and collect trading fees while the price stays in your range. If you hold only one version, part of it is swapped into the other side when you open the position, and a 0.10% SoFinance fee applies to the swapped amount. The position stays in your own wallet.",
      },
      {
        question: "Is SoFinance custodial? What if the site goes offline?",
        answer:
          "SoFinance is self-custodial. It never holds your private keys or tokens; every action is a transaction you sign in your own wallet and can check on a block explorer (Solscan for Solana, Blockscout for Robinhood Chain). On Solana your position is a standard Raydium position NFT, and on Robinhood Chain a standard Uniswap v4 position, so you could still manage or withdraw it directly with the underlying protocol. Self-custodial does not mean risk-free: issuer controls such as freezing, smart contract risk and market risk still apply.",
      },
      {
        question: "How much does SoFinance cost?",
        answer:
          "SoFinance charges a 10 basis point (0.10%) protocol fee only on amounts it swaps for you: opening a position from other tokens, compounding, or withdrawing to USDC. Withdrawing as the two original pool tokens has no SoFinance fee. You also pay network fees, swap route costs and, on Solana, small account deposits that mostly come back when you close the position. The preview lists every cost before you sign.",
      },
      {
        question: "Can an AI agent use SoFinance for me?",
        answer:
          "Yes, with limits. SoFinance runs an MCP server, so an AI assistant can list same-stock pools, quote a position and prepare an unsigned transaction. Only your wallet can approve and sign it. Connect an agent from sofinancelab.xyz/app/ai.",
      },
    ],
  },
  {
    id: "buying-onchain",
    title: "Buying stocks onchain",
    items: [
      {
        question: "How can I buy US stocks onchain?",
        answer:
          "SoFinance does not sell stocks. Common routes are: (1) Backpack Securities: in a supported region, buy shares in a verified Backpack account and withdraw them to a Solana wallet as tokens; (2) xStocks through a listing exchange, then withdraw to a Solana wallet; (3) swap USDC for a tokenized stock on a DEX or aggregator such as Jupiter or Raydium; (4) on Robinhood Chain, Robinhood stock tokens and Ondo Global Markets tokens, where the issuer offers them to you. Check the issuer's and venue's eligibility rules first. Once you hold the tokens, SoFinance is where you can pair them into a same-stock pool to collect trading fees.",
      },
      {
        question: "Can I buy tokenized US stocks if I live outside the US?",
        answer:
          "Often yes, but it depends on where you live and on each issuer's rules. Tokenized stocks such as xStocks are generally not available to US persons, and every issuer restricts some other countries. Read the issuer's terms for your country before buying. SoFinance does not decide eligibility and cannot override it.",
      },
      {
        question: "Is SoFinance a broker? Does it give me shares?",
        answer:
          "No. SoFinance is not a broker, does not sell or issue stocks, and does not hold your assets. It is an LP tool: it helps people who already hold tokenized stocks, or who swap into them while opening a position, provide liquidity on Raydium or Uniswap v4. Rights such as redemption into real shares come from the token issuer, not from SoFinance.",
      },
    ],
  },
];

export const FAQ_ITEMS: readonly FaqItem[] = FAQ_SECTIONS.flatMap((section) => section.items);

export function faqJsonLd(pageUrl: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${pageUrl}#faq`,
    url: pageUrl,
    mainEntity: FAQ_ITEMS.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}
