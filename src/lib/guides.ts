import { ORGANIZATION_ID, type JsonLd } from "@/lib/json-ld";
import { APP_ROUTES, CANONICAL_SITE_URL, DOCS_ROUTES, FAQ_ROUTE, GUIDE_ROUTES, blogArticlePath } from "@/lib/public-urls";

/**
 * Public guide pages (`/fees`, `/use-cases/*`, `/learn/*`): plain answers to the questions people ask search engines
 * and AI assistants. One source for the visible page and its Article + FAQPage JSON-LD, so the structured data always
 * matches what a reader sees (the page test checks it).
 *
 * Copy rules: "collect trading fees" (never earn / yield / passive income); every APR or volume figure names its
 * window and date and says "Fees not guaranteed"; price views say "Not a prediction"; ranges are 4 presets scored on
 * 7 days of fee data and never move automatically; one-click compound is on Raydium and Meteora, not Robinhood Chain.
 */
export type GuideBlock =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: readonly string[] }
  | { kind: "ol"; items: readonly string[] };

/** One question and its answer. The first sentence of the first block answers the question directly. */
export type GuideQa = { id: string; question: string; blocks: readonly GuideBlock[] };

export type GuideKind = "pricing" | "use-case" | "learn";

export type GuidePage = {
  slug: string;
  kind: GuideKind;
  path: string;
  /** Short name for footers, the docs sidebar and the /learn index. */
  label: string;
  metaTitle: string;
  metaDescription: string;
  heroLabel: string;
  title: string;
  intro: string;
  qas: readonly GuideQa[];
  related: readonly { href: string; label: string }[];
  /** Date the copy (and any snapshot figures in it) was last checked, YYYY-MM-DD. */
  updated: string;
};

/** Pools-page snapshot behind the figures on the use-case pages (`/api/rwa-pairs` fetchedAt). */
export const GUIDE_SNAPSHOT_LABEL = "24h window, pools-page snapshot of 14 November 2026, 12:16 UTC";

export const GUIDE_RISK_LINE =
  "Liquidity providing can lose money. Fee APR and volume figures come from recent windows and change daily. Fees not guaranteed. Not investment advice.";

const p = (text: string): GuideBlock => ({ kind: "p", text });
const ul = (...items: string[]): GuideBlock => ({ kind: "ul", items });
const ol = (...items: string[]): GuideBlock => ({ kind: "ol", items });

const PRESETS_LINE =
  "SoFinance scores 4 range presets (Micro, Tight, Standard and Wide) on the last 7 days of fee data for the amount you enter and highlights the one with the highest estimated fee APR; you can pick another preset or type a custom range.";

const NO_REBALANCE_LINE =
  "There is no auto-rebalance: if the pool price leaves your range, the position collects no trading fees until the price comes back or you withdraw and open a new range.";

const COMPOUND_LINE =
  "One-click compound is available for Raydium and Meteora positions on Solana; Robinhood Chain positions have no compound.";

const FEES: GuidePage = {
  slug: "fees",
  kind: "pricing",
  path: GUIDE_ROUTES.fees,
  label: "Pricing",
  metaTitle: "Pricing: zero performance fee, 0.10% only when we swap",
  metaDescription:
    "SoFinance takes zero performance fee. We charge 0.10% only when a swap is made for you; withdrawing as the two pool tokens costs 0. Network fees are paid by you.",
  heroLabel: "Pricing",
  title: "Zero performance fee. 0.10% only when we swap.",
  intro:
    "SoFinance takes no cut of the trading fees your position collects. The only SoFinance fee is 0.10% on the part of a transaction we swap for you, shown in the preview before you sign.",
  qas: [
    {
      id: "how-much",
      question: "How much does SoFinance charge?",
      blocks: [
        p("SoFinance charges a 0.10% (10 basis point) protocol fee only when a swap is made for you, and takes zero performance fee on the trading fees your position collects. If an action needs no swap, there is no SoFinance fee. The preview shows the fee before you sign, and it is taken inside the same transaction."),
      ],
    },
    {
      id: "performance-fee",
      question: "Does SoFinance take a performance fee on the trading fees I collect?",
      blocks: [
        p("No, SoFinance takes zero performance fee: the trading fees your position collects are yours, and compounding them adds no performance fee. " + COMPOUND_LINE + " Compound charges 0.10% only on the harvested tokens that are swapped to rebalance the position; if no swap is needed, there is no SoFinance fee."),
      ],
    },
    {
      id: "which-actions",
      question: "Which actions cost 0.10%, and which cost nothing?",
      blocks: [
        p("Only the swapped part of an action costs 0.10%; anything deposited or withdrawn without a swap costs 0 in SoFinance fees."),
        ul(
          "Solana, opening or adding to a position: 0.10% of the part of your deposit that is swapped, in the token you deposit. A part deposited directly, without a swap, is not charged.",
          "Solana, buying a stock token with USDC in the app (spot swap): 0.10% of the part that is swapped, in USDC.",
          "Solana, compounding a Raydium or Meteora position: 0.10% of the harvested tokens swapped to rebalance. No swap, no fee.",
          "Solana, withdrawing to USDC or another single token: 0.10% of the tokens that are converted.",
          "Solana, withdrawing as the two pool tokens: 0.",
          "Robinhood Chain, opening a position: 0.10% of the tokens the swap returns, when part of your deposit is swapped. No swap, no fee.",
          "Robinhood Chain, closing a position: 0. You receive the two pool tokens.",
        ),
      ],
    },
    {
      id: "withdraw",
      question: "Does withdrawing cost anything?",
      blocks: [
        p("Withdrawing as the two pool tokens costs 0 in SoFinance fees; withdrawing to USDC or another single token on Solana costs 0.10% of the tokens converted. You can withdraw at any time, and you still pay the normal network fee for the transaction."),
      ],
    },
    {
      id: "network-fees",
      question: "Who pays network fees?",
      blocks: [
        p("You do: your wallet pays the normal network fee for each transaction you sign, in SOL on Solana and ETH on Robinhood Chain, and that fee goes to the network, not to SoFinance. On Solana, opening a position also needs small SOL account deposits; most come back when you close the position, and the preview lists each one. Keep a little SOL or ETH on top of what you invest."),
      ],
    },
    {
      id: "pool-swap-fees",
      question: "Where do the pool's swap fees go?",
      blocks: [
        p("The liquidity providers' share of each pool's swap fees goes to the LPs whose range is active at the current price, and SoFinance takes none of it. Each DEX (Raydium, Meteora, Uniswap v4) sets its own fee tier and may keep a protocol share under its own rules. While the price is outside your range, your position collects no trading fees. Fees not guaranteed."),
      ],
    },
    {
      id: "vs-vaults",
      question: "How does SoFinance pricing compare with automated LP vaults?",
      blocks: [
        p("Many automated LP vaults take a performance fee out of the trading fees a position collects, and SoFinance takes none. In the products we checked on 13 November 2026 (UTC), from each project's own docs: HawkFi 8%, Steer Smart Pools 15%, Beefy CLM up to 9.5%, Gamma 14–20%, and Kamino Liquidity a rate that varies by vault. Circuit's agent charged no fee on that date."),
        p("Those products auto-rebalance or auto-compound for you, which is a real service; SoFinance does not auto-rebalance, and you sign every transaction. SoFinance also charges 0.10% when it swaps for you. Sources and the full table are in our comparison post."),
      ],
    },
    {
      id: "other-costs",
      question: "Are there other costs in the preview?",
      blocks: [
        p("Yes, the preview lists every cost before you sign: the 0.10% protocol fee when a swap is made, the swap route's own trading fee and price impact on larger swaps, the network fee, and on Solana the refundable account deposits."),
        p("Swaps also carry a price-protection limit (0.5% on Solana, 0.05% on Robinhood Chain): if the price moves more than that, the swap fails instead of filling worse. We may change the protocol fee; any change would be announced in advance and shown in the preview."),
      ],
    },
  ],
  related: [
    { href: DOCS_ROUTES.fees, label: "Docs: fee details" },
    { href: blogArticlePath("competitor-comparison"), label: "How SoFinance compares" },
    { href: DOCS_ROUTES.withdraw, label: "Withdraw anytime" },
    { href: DOCS_ROUTES.risks, label: "Risks" },
  ],
  updated: "2026-11-14",
};

const TSLA: GuidePage = {
  slug: "tsla-same-stock-lp",
  kind: "use-case",
  path: GUIDE_ROUTES.tslaUseCase,
  label: "TSLA same-stock LP",
  metaTitle: "TSLA same-stock LP: TSLA/TSLAx pools on Meteora and Raydium",
  metaDescription:
    "How to provide liquidity to a Tesla same-stock pool (TSLA/TSLAx) on Solana with SoFinance: what the pool is, why volume vs TVL matters, step-by-step open, and risks.",
  heroLabel: "Use case",
  title: "Tesla same-stock LP: TSLA / TSLAx",
  intro:
    "Pair Backpack Securities' TSLA with the xStocks TSLAx token in one pool and collect trading fees from swaps between them. Self-custodial: you sign every transaction.",
  qas: [
    {
      id: "what",
      question: "What is the TSLA same-stock pool?",
      blocks: [
        p("The TSLA same-stock pool is a liquidity pool where both tokens are Tesla stock from two issuers: TSLA from Backpack Securities and TSLAx from xStocks, on Solana. SoFinance lists a TSLA/TSLAx pool on Meteora DLMM and one on Raydium CLMM. On Robinhood Chain, a Uniswap v4 pool pairs the Robinhood TSLA token with the Ondo Global Markets version, TSLAon."),
      ],
    },
    {
      id: "why-swaps",
      question: "Why do traders swap between TSLA and TSLAx?",
      blocks: [
        p("Traders swap between TSLA and TSLAx because the two tokens come from different issuers, with different venues, buyers and redemption routes, so their prices drift slightly apart. Arbitrage and routing swaps close that gap, and every swap pays the pool fee to the LPs whose range is active. Because both tokens track the same share, the pool price usually stays close to 1:1, which makes narrow ranges practical."),
      ],
    },
    {
      id: "volume-tvl",
      question: "Why does volume compared with TVL matter for a TSLA pool?",
      blocks: [
        p("Volume relative to TVL is the main driver of how many trading fees each dollar of liquidity collects: fees come from volume and are shared across the liquidity active at the current price. A pool with high volume on low TVL spreads more fees across each dollar; a pool with little volume collects little, whatever its fee tier."),
        p(`Snapshot (${GUIDE_SNAPSHOT_LABEL}):`),
        ul(
          "Meteora DLMM TSLA/TSLAx, 0.01% fee tier: about $121.7k of 24h volume on about $47.2k TVL.",
          "Raydium CLMM TSLA/TSLAx, 0.05% fee tier: about $160 of 24h volume on about $2.2k TVL.",
        ),
        p("These figures change every day, and a single day is noisy; the pools page shows the current 7-day range APR for each pool. Fees not guaranteed."),
      ],
    },
    {
      id: "how-to-open",
      question: "How do I open a TSLA/TSLAx position on SoFinance?",
      blocks: [
        p("You open a TSLA/TSLAx position from the SoFinance pools page in a few steps, and your wallet signs once to open it."),
        ol(
          "Open sofinancelab.xyz/app/rwa-pairs and search for TSLA.",
          "Choose the Meteora or Raydium TSLA/TSLAx pool and press Open position.",
          "Connect a Solana wallet such as Phantom.",
          "Pick what to deposit (SOL, USDC, TSLA or TSLAx) and how much. If you deposit one token, part of it is swapped into the other side, with the 0.10% fee on the swapped part.",
          "Review the suggested range preset and the preview: estimated fee APR (7-day window), every cost, and what you will hold.",
          "Press Add liquidity and approve in your wallet. The app simulates the transaction again before sending it.",
        ),
      ],
    },
    {
      id: "range",
      question: "Which range should I pick for TSLA/TSLAx?",
      blocks: [
        p(PRESETS_LINE + " On Meteora the presets map to the pool's price bins, so two of them can merge into one."),
        p("The 7-day estimate assumes recent volume continues and ignores impermanent loss and your costs. Not a prediction. Fees not guaranteed. " + NO_REBALANCE_LINE),
      ],
    },
    {
      id: "compound",
      question: "Can I compound the trading fees from a TSLA position?",
      blocks: [
        p("Yes, on Solana: " + COMPOUND_LINE + " Compound adds collected trading fees back into the same position and charges 0.10% only on the part swapped to rebalance."),
      ],
    },
    {
      id: "risks",
      question: "What are the risks of a TSLA same-stock LP position?",
      blocks: [
        p("A TSLA same-stock position can lose money: its value moves with Tesla's share price, and LP adds its own risks on top."),
        ul(
          "Tesla price risk: both tokens track TSLA, so the position's dollar value rises and falls with the stock.",
          "Out of range: if the TSLA/TSLAx price leaves your range, the position collects no trading fees and holds only one of the two tokens.",
          "Impermanent loss: a premium or discount between TSLA and TSLAx shifts your position toward the cheaper token.",
          "Issuer controls: both tokens are Token-2022 tokens whose issuers keep a freeze authority, which can block transfers.",
          "Smart contract and network risk in Meteora, Raydium, Jupiter and Solana.",
          "Eligibility: xStocks are not offered to US persons or in some other countries.",
        ),
      ],
    },
  ],
  related: [
    { href: APP_ROUTES.rwaPairs, label: "Live pools and 7-day APR" },
    { href: GUIDE_ROUTES.howToOpen, label: "How to open an LP position" },
    { href: GUIDE_ROUTES.impermanentLoss, label: "Impermanent loss on same-stock pools" },
    { href: DOCS_ROUTES.risks, label: "Risks" },
  ],
  updated: "2026-11-14",
};

const SPCX: GuidePage = {
  slug: "spcx-same-stock-lp",
  kind: "use-case",
  path: GUIDE_ROUTES.spcxUseCase,
  label: "SPCX same-stock LP",
  metaTitle: "SPCX same-stock LP: SPCX/SPCXx pools on Raydium and Meteora",
  metaDescription:
    "How to provide liquidity to the SpaceX same-stock pool (SPCX/SPCXx) on Solana with SoFinance: the pools, why volume vs TVL matters, step-by-step open, and risks.",
  heroLabel: "Use case",
  title: "SpaceX same-stock LP: SPCX / SPCXx",
  intro:
    "Pair Backpack Securities' SPCX with the xStocks SPCXx token in one pool and collect trading fees from swaps between them. Self-custodial: you sign every transaction.",
  qas: [
    {
      id: "what",
      question: "What is the SPCX same-stock pool?",
      blocks: [
        p("The SPCX same-stock pool pairs two tokens that track the same SpaceX share: SPCX from Backpack Securities and SPCXx from xStocks, on Solana. SoFinance lists SPCX/SPCXx pools on Raydium CLMM (two fee tiers) and on Meteora DLMM. On Robinhood Chain, a Uniswap v4 pool pairs the Robinhood SPCX token with its Ondo Global Markets version."),
      ],
    },
    {
      id: "volume-tvl",
      question: "Why does volume compared with TVL matter for SPCX pools?",
      blocks: [
        p("Volume relative to TVL decides how many trading fees each dollar of liquidity collects, so the same pair can look very different in each pool. Fees come from swaps and are shared across the liquidity active at the current price."),
        p(`Snapshot (${GUIDE_SNAPSHOT_LABEL}):`),
        ul(
          "Raydium CLMM SPCX/SPCXx, 0.01% fee tier: about $316.4k of 24h volume on about $246.6k TVL.",
          "Meteora DLMM SPCX/SPCXx, 0.01% fee tier: about $38.3k of 24h volume on about $29.3k TVL.",
          "Raydium CLMM SPCX/SPCXx, 0.05% fee tier: about $430 of 24h volume on about $4.9k TVL.",
        ),
        p("A higher fee tier does not help if swaps route elsewhere. These figures change every day; the pools page shows the current 7-day range APR for each pool. Fees not guaranteed."),
      ],
    },
    {
      id: "which-pool",
      question: "Should I use the Raydium or the Meteora SPCX pool?",
      blocks: [
        p("Either works in SoFinance with the same steps; compare each pool's 7-day range APR, TVL and volume on the pools page, because the better pool changes over time. Raydium CLMM positions are standard Raydium position NFTs; Meteora DLMM positions are Meteora position accounts owned by your wallet. " + COMPOUND_LINE),
      ],
    },
    {
      id: "how-to-open",
      question: "How do I open an SPCX/SPCXx position on SoFinance?",
      blocks: [
        p("You open an SPCX/SPCXx position from the SoFinance pools page, and your wallet signs once to open it."),
        ol(
          "Open sofinancelab.xyz/app/rwa-pairs and search for SPCX.",
          "Choose a Raydium or Meteora SPCX/SPCXx pool and press Open position.",
          "Connect a Solana wallet such as Phantom.",
          "Pick what to deposit (SOL, USDC, SPCX or SPCXx) and how much. If you deposit one token, part of it is swapped into the other side, with the 0.10% fee on the swapped part.",
          "Review the suggested range preset and the preview: estimated fee APR (7-day window), every cost, and what you will hold.",
          "Press Add liquidity and approve in your wallet. The app simulates the transaction again before sending it.",
        ),
      ],
    },
    {
      id: "range",
      question: "Which range should I pick for SPCX/SPCXx?",
      blocks: [
        p(PRESETS_LINE + " Narrow presets show a higher estimate and leave range more often."),
        p("The estimate assumes recent volume continues and ignores impermanent loss and your costs. Not a prediction. Fees not guaranteed. " + NO_REBALANCE_LINE),
      ],
    },
    {
      id: "risks",
      question: "What are the risks of an SPCX same-stock LP position?",
      blocks: [
        p("An SPCX same-stock position can lose money: its value follows the SPCX tokens' price, and LP adds its own risks."),
        ul(
          "Price risk: both tokens track the same share, so the position's dollar value moves with it.",
          "Out of range: if the SPCX/SPCXx price leaves your range, the position collects no trading fees and holds only one token.",
          "Impermanent loss: a premium or discount between SPCX and SPCXx shifts your position toward the cheaper token.",
          "Issuer controls: Token-2022 stock tokens can keep a freeze authority that can block transfers.",
          "Smart contract and network risk in Raydium, Meteora, Jupiter and Solana.",
          "Eligibility: xStocks are not offered to US persons or in some other countries.",
        ),
      ],
    },
  ],
  related: [
    { href: APP_ROUTES.rwaPairs, label: "Live pools and 7-day APR" },
    { href: GUIDE_ROUTES.whatIsSameStock, label: "What is a same-stock LP pool?" },
    { href: GUIDE_ROUTES.howToOpen, label: "How to open an LP position" },
    { href: DOCS_ROUTES.risks, label: "Risks" },
  ],
  updated: "2026-11-14",
};

const WHAT_IS: GuidePage = {
  slug: "what-is-a-same-stock-lp-pool",
  kind: "learn",
  path: GUIDE_ROUTES.whatIsSameStock,
  label: "What is a same-stock LP pool?",
  metaTitle: "What is a same-stock LP pool? Tokenized stock liquidity explained",
  metaDescription:
    "A same-stock LP pool pairs two issuers' tokens of one stock, like TSLA/TSLAx or SPCX/SPCXx. How it works, how LPs collect trading fees, and the risks.",
  heroLabel: "Learn",
  title: "What is a same-stock LP pool?",
  intro:
    "A beginner's guide to pools that pair two tokenized versions of the same stock, and how liquidity providers collect trading fees in them.",
  qas: [
    {
      id: "what",
      question: "What is a same-stock LP pool?",
      blocks: [
        p("A same-stock LP pool is a liquidity pool where both tokens track the same stock but come from two different issuers, such as TSLA (Backpack Securities) and TSLAx (xStocks) on Solana. Traders swap between the two versions, each swap pays the pool fee, and liquidity providers (LPs) collect those trading fees while their range is active."),
      ],
    },
    {
      id: "examples",
      question: "Which tokens get paired in same-stock pools?",
      blocks: [
        p("Same-stock pools pair one issuer's token with another issuer's token for the same share."),
        ul(
          "Solana: a Backpack Securities token with the xStocks token, for example SPCX/SPCXx, TSLA/TSLAx or MSTR/MSTRx, on Raydium CLMM or Meteora DLMM.",
          "Robinhood Chain: a Robinhood stock token with the Ondo Global Markets token, for example NVDA/NVDAon, on Uniswap v4 pools that use a reviewed StablePairHook.",
        ),
        p("The live list of pools SoFinance supports is on the pools page."),
      ],
    },
    {
      id: "near-one",
      question: "Why does a same-stock pool trade near 1:1?",
      blocks: [
        p("A same-stock pool trades near 1:1 because both tokens represent the same share, so neither should be worth much more than the other. Small premiums and discounts still appear when one version has more buyers or is easier to redeem, and those gaps are what swaps close. Because the price moves in a narrow band, LPs can use tight concentrated ranges."),
      ],
    },
    {
      id: "fees",
      question: "How do LPs collect trading fees in a same-stock pool?",
      blocks: [
        p("LPs collect a share of every swap fee in proportion to the liquidity they have active at the current price. In concentrated-liquidity pools you choose a price range; your position collects fees only while the pool price is inside it. The fee tier (for example 0.01% or 0.05%) is set by the pool, and fees depend on volume, not on the stock going up. Fees not guaranteed."),
      ],
    },
    {
      id: "vs-normal",
      question: "How is a same-stock pool different from a stock/USDC pool?",
      blocks: [
        p("A same-stock pool pairs two versions of one stock, while a stock/USDC pool pairs a stock with a dollar token. In a stock/USDC pool the relative price moves every time the stock moves, so impermanent loss and out-of-range time are usually larger. In a same-stock pool the relative price stays near 1:1, but your position still holds stock tokens, so its dollar value moves with the share price."),
      ],
    },
    {
      id: "risk-free",
      question: "Is a same-stock LP pool risk-free?",
      blocks: [
        p("No, a same-stock LP position can lose money. The position's value moves with the stock price; a premium or discount between the two issuers causes impermanent loss; out of range it collects no trading fees; and token issuers can freeze Token-2022 tokens. Smart contract and network risks also apply."),
      ],
    },
    {
      id: "sofinance",
      question: "What does SoFinance do for same-stock pools?",
      blocks: [
        p("SoFinance is a self-custodial tool that finds same-stock pools, suggests a range and opens, compounds and withdraws positions from your own wallet. " + PRESETS_LINE + " " + NO_REBALANCE_LINE + " " + COMPOUND_LINE + " SoFinance takes zero performance fee and charges 0.10% only when it swaps for you."),
      ],
    },
  ],
  related: [
    { href: GUIDE_ROUTES.howToOpen, label: "How to open an LP position" },
    { href: GUIDE_ROUTES.impermanentLoss, label: "Impermanent loss on same-stock pools" },
    { href: GUIDE_ROUTES.tslaUseCase, label: "TSLA same-stock LP" },
    { href: FAQ_ROUTE, label: "FAQ" },
  ],
  updated: "2026-11-14",
};

const HOW_TO_OPEN: GuidePage = {
  slug: "how-to-open-an-lp-position",
  kind: "learn",
  path: GUIDE_ROUTES.howToOpen,
  label: "How to open an LP position",
  metaTitle: "How to open an LP position on Raydium, Meteora or Robinhood Chain",
  metaDescription:
    "Step by step: open a same-stock liquidity position with SoFinance on Raydium CLMM or Meteora DLMM (Solana) or Uniswap v4 (Robinhood Chain), from your own wallet.",
  heroLabel: "Learn",
  title: "How to open an LP position",
  intro:
    "A step-by-step guide to opening a same-stock liquidity position with SoFinance, on Solana (Raydium and Meteora) and Robinhood Chain.",
  qas: [
    {
      id: "need",
      question: "What do I need before opening an LP position?",
      blocks: [
        p("You need a browser wallet and something to deposit: on Solana a wallet such as Phantom with SOL, USDC or a stock token, and on Robinhood Chain an EVM wallet such as MetaMask with a stock token and a little ETH. Keep a little SOL or ETH for network fees on top of what you invest. Check that the token issuers offer their tokens where you live."),
      ],
    },
    {
      id: "solana-steps",
      question: "How do I open a position on Raydium or Meteora with SoFinance?",
      blocks: [
        p("On Solana, Raydium CLMM and Meteora DLMM pools use the same SoFinance steps, and your wallet signs once."),
        ol(
          "Go to sofinancelab.xyz/app/rwa-pairs and pick a same-stock pool, for example TSLA/TSLAx or SPCX/SPCXx. The Raydium or Meteora label shows which DEX the pool is on.",
          "Press Open position and connect your Solana wallet.",
          "Choose what to deposit (SOL, USDC or one of the pool tokens) and the amount.",
          "Review the suggested range preset (Micro, Tight, Standard or Wide), scored on the last 7 days of fee data. You can pick another preset or type a custom range.",
          "Read the preview: estimated fee APR with its 7-day window, the 0.10% fee on any swapped part, network fees, refundable account deposits, and what you will hold.",
          "Press Add liquidity and approve in your wallet. The app simulates the transaction again before sending it.",
          "Find the position under Portfolio. You can verify the transaction on Solscan.",
        ),
      ],
    },
    {
      id: "raydium-vs-meteora",
      question: "What is the difference between a Raydium and a Meteora position?",
      blocks: [
        p("A Raydium CLMM position is a standard Raydium position NFT with a price range set in ticks, while a Meteora DLMM position is a Meteora position account owned by your wallet, with liquidity spread over price bins. In SoFinance both open, compound and withdraw the same way. On Meteora the range presets map to the pool's bins, so two presets can merge into one. Either position can also be managed directly on its DEX without SoFinance."),
      ],
    },
    {
      id: "rhc-steps",
      question: "How do I open a position on Robinhood Chain?",
      blocks: [
        p("On Robinhood Chain you open a Uniswap v4 same-stock position from the same pools page with an EVM wallet."),
        ol(
          "Pick a Robinhood Chain pool on sofinancelab.xyz/app/rwa-pairs, for example NVDA/NVDAon.",
          "Connect an EVM wallet; the app asks it to switch to or add Robinhood Chain.",
          "Enter the token and amount, review the range and the simulated preview.",
          "Approve in your wallet. The position is a standard Uniswap v4 position NFT.",
        ),
        p("Robinhood Chain positions have no compound; closing returns the two pool tokens with no SoFinance fee."),
      ],
    },
    {
      id: "after",
      question: "What should I do after opening a position?",
      blocks: [
        p("After opening, check whether the price is still inside your range, because the position collects trading fees only while it is. " + NO_REBALANCE_LINE + " " + COMPOUND_LINE + " Withdrawing as the two pool tokens costs 0 in SoFinance fees."),
      ],
    },
    {
      id: "how-much",
      question: "How much should I deposit for my first position?",
      blocks: [
        p("Start with an amount you can afford to lose while you learn how ranges behave. Very small deposits in the narrowest presets can fail to settle quotes, so the app may suggest a little more. Larger deposits in the same range usually collect fees at a lower rate than the reference amount the estimate starts from. Fees not guaranteed."),
      ],
    },
  ],
  related: [
    { href: APP_ROUTES.rwaPairs, label: "Open the pools page" },
    { href: GUIDE_ROUTES.whatIsSameStock, label: "What is a same-stock LP pool?" },
    { href: GUIDE_ROUTES.fees, label: "Pricing" },
    { href: DOCS_ROUTES.withdraw, label: "Withdraw anytime" },
  ],
  updated: "2026-11-14",
};

const IMPERMANENT_LOSS: GuidePage = {
  slug: "impermanent-loss-on-same-stock-pools",
  kind: "learn",
  path: GUIDE_ROUTES.impermanentLoss,
  label: "Impermanent loss on same-stock pools",
  metaTitle: "Impermanent loss on same-stock pools (TSLA/TSLAx, SPCX/SPCXx)",
  metaDescription:
    "Impermanent loss still applies to same-stock LP pools. When it happens, how big it can get in a narrow range, an illustrated example, and how to limit it.",
  heroLabel: "Learn",
  title: "Impermanent loss on same-stock pools",
  intro:
    "Same-stock pools usually trade near 1:1, so impermanent loss tends to be small, but it is not zero. Here is when it happens and how to think about it.",
  qas: [
    {
      id: "what",
      question: "What is impermanent loss?",
      blocks: [
        p("Impermanent loss is the gap between the value of your LP position and the value you would have had by simply holding the same tokens. It happens because, as the relative price of the two tokens moves, the pool sells the token that is getting more expensive and buys the one getting cheaper. If the price returns to where you entered, the gap closes; if you withdraw while it is open, it becomes a real loss."),
      ],
    },
    {
      id: "applies",
      question: "Does impermanent loss apply to same-stock pools?",
      blocks: [
        p("Yes, impermanent loss applies to same-stock pools, but usually less than in a stock/USDC pool, because the two tokens track the same share and trade near 1:1. It appears whenever one issuer's token trades at a premium or discount to the other, for example TSLAx a little below TSLA."),
      ],
    },
    {
      id: "when",
      question: "What causes the price gap between two tokens of the same stock?",
      blocks: [
        p("The gap comes from differences between the issuers and their markets, not from the stock itself."),
        ul(
          "One version has more buyers, or more liquidity on other venues.",
          "Minting and redemption are slower or harder for one issuer, so arbitrage takes longer.",
          "An issuer pauses, freezes or restricts its token.",
          "Weekends and market closures, when the underlying share does not trade and onchain prices can drift.",
        ),
      ],
    },
    {
      id: "example",
      question: "How big can impermanent loss get in a narrow range?",
      blocks: [
        p("In a narrow range, the worst case is that the price crosses your whole range and your position ends up entirely in the cheaper token. Illustration, not a prediction: with a Wide range of about ±1% opened at 1:1, if TSLAx falls to 1% below TSLA and stays there, the position holds only TSLAx and is worth about 0.25% less than holding the original mix. A narrower range reaches that point after a smaller move."),
      ],
    },
    {
      id: "fees-offset",
      question: "Can trading fees make up for impermanent loss?",
      blocks: [
        p("Trading fees can offset some or all of impermanent loss, but not always. Fees depend on volume and on how long your range stays active; impermanent loss depends on the price path. The fee APR estimates in SoFinance ignore impermanent loss, so compare both. Fees not guaranteed."),
      ],
    },
    {
      id: "limit",
      question: "How can I limit impermanent loss on a same-stock pool?",
      blocks: [
        p("You can limit impermanent loss by choosing a range that fits how far the pair usually moves, watching for issuer events, and sizing the position so you can wait out a temporary gap."),
        ul(
          "Wider presets leave range less often and lose less per move; narrower ones collect more per dollar while in range.",
          "SoFinance's suggested preset is scored on 7 days of fee data; it does not move later, so check the position yourself.",
          "Withdrawing as the two pool tokens costs 0 in SoFinance fees, so you are not forced to sell into the gap.",
        ),
      ],
    },
  ],
  related: [
    { href: DOCS_ROUTES.risks, label: "Risks" },
    { href: DOCS_ROUTES.feeApr, label: "How fee APR is estimated" },
    { href: GUIDE_ROUTES.whatIsSameStock, label: "What is a same-stock LP pool?" },
    { href: GUIDE_ROUTES.spcxUseCase, label: "SPCX same-stock LP" },
  ],
  updated: "2026-11-14",
};

/** Every guide page, in footer / sitemap / index order. */
export const GUIDE_PAGES: readonly GuidePage[] = [FEES, WHAT_IS, HOW_TO_OPEN, IMPERMANENT_LOSS, TSLA, SPCX];

export const GUIDES_UPDATED = "2026-11-14";

export function guideBySlug(kind: GuideKind, slug: string): GuidePage | undefined {
  return GUIDE_PAGES.find((page) => page.kind === kind && page.slug === slug);
}

export function guidesOfKind(kind: GuideKind): GuidePage[] {
  return GUIDE_PAGES.filter((page) => page.kind === kind);
}

/** Plain-text answer used in JSON-LD: the visible blocks joined in order. */
export function guideAnswerText(qa: GuideQa): string {
  return qa.blocks.map((block) => (block.kind === "p" ? block.text : block.items.join(" "))).join(" ");
}

export function guideJsonLd(page: GuidePage): JsonLd {
  const url = `${CANONICAL_SITE_URL}${page.path}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        headline: page.title,
        description: page.metaDescription,
        url,
        mainEntityOfPage: url,
        dateModified: page.updated,
        inLanguage: "en",
        author: { "@id": ORGANIZATION_ID },
        publisher: { "@id": ORGANIZATION_ID },
        isPartOf: { "@id": `${CANONICAL_SITE_URL}/#website` },
      },
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        url,
        mainEntity: page.qas.map((qa) => ({
          "@type": "Question",
          name: qa.question,
          acceptedAnswer: { "@type": "Answer", text: guideAnswerText(qa) },
        })),
      },
    ],
  };
}

/** Index page (`/learn`) copy. */
export const LEARN_INDEX = {
  path: GUIDE_ROUTES.learn,
  metaTitle: "Learn: same-stock LP guides, pricing and use cases",
  metaDescription:
    "Beginner guides to same-stock liquidity pools: what they are, how to open a position on Raydium, Meteora or Robinhood Chain, impermanent loss, pricing and TSLA/SPCX use cases.",
} as const;

