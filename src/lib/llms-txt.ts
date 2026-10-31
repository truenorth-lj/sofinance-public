import { articleCanonicalPath, listBlogArticles } from "@/lib/blog";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { FAQ_POOLS_AS_OF, FAQ_RISK_LINE } from "@/lib/faq";
import { APP_ROUTES, CANONICAL_SITE_URL, FAQ_ROUTE } from "@/lib/public-urls";
import { SOCIAL_LINKS } from "@/lib/social-links";

const url = (path: string) => (path === "/" ? CANONICAL_SITE_URL : `${CANONICAL_SITE_URL}${path}`);

/** Same-stock Solana pools (Raydium CLMM) on the live pools page when this file was last reviewed. */
const SOLANA_POOLS = [
  "SPCX / SPCXx (SpaceX), two fee tiers",
  "MSTR / MSTRx (Strategy)",
  "NVDA / NVDAx (Nvidia)",
  "GOOGL / GOOGLx (Alphabet)",
  "AAPL / AAPLx (Apple)",
  "TSLA / TSLAx (Tesla), two fee tiers",
  "META / METAx (Meta), two fee tiers",
  "AMZN / AMZNx (Amazon)",
  "INTC / INTCx (Intel)",
  "AMD / AMDx (AMD)",
  "AVGO / AVGOx (Broadcom)",
  "SNDK / SNDKx (SanDisk)",
  "SKHY / SKHYx (SK hynix)",
  "HOOD / HOODx (Robinhood)",
  "USDC / USDT (stablecoin pool)",
];

/** Robinhood Chain: the reviewed Uniswap v4 StablePairHook allowlist (Robinhood token / Ondo Global Markets token). */
const ROBINHOOD_CHAIN_POOLS = [
  "SPCX / SPCXon (SpaceX)",
  "NVDA / NVDAon (Nvidia)",
  "SPY / SPYon (S&P 500 ETF)",
  "META / METAon (Meta)",
  "GOOGL / GOOGLon (Alphabet)",
  "AAPL / AAPLon (Apple)",
  "MSTR / MSTRon (Strategy)",
  "CRCL / CRCLon (Circle)",
  "TSLA / TSLAon (Tesla)",
  "QQQ / QQQon (Nasdaq-100 ETF)",
  "GME / GMEon (GameStop)",
];

/** `/llms.txt` (llmstxt.org): a plain-text map of the public site for AI assistants and answer engines. */
export function buildLlmsTxt(): string {
  const docs = DOCS_PAGES.map((page) => `- [${page.title}](${url(page.href)}): ${page.metaDescription}`);
  const blog = listBlogArticles().map(
    (article) => `- [Blog: ${article.title}](${url(articleCanonicalPath(article.slug))}): ${article.description}`,
  );

  return `# SoFinance

> SoFinance (${CANONICAL_SITE_URL}) is a self-custodial tool for providing liquidity to same-stock pools of tokenized stocks, on Solana and Robinhood Chain. Both sides of a pool are the same underlying stock from two issuers: on Solana a Backpack Securities token and the xStocks token on Raydium CLMM (for example SPCX/SPCXx, MSTR/MSTRx), on Robinhood Chain a Robinhood stock token and the Ondo Global Markets token on Uniswap v4 (for example NVDA/NVDAon). You pick a pool and a price range, review a preview, and open the position from your own wallet. While the pool price is inside your range, the position collects a share of the trading fees that swappers pay. SoFinance never holds your keys or funds.

SoFinance is not a broker, does not sell stocks, and does not issue tokens. It builds transactions; your wallet signs them. ${FAQ_RISK_LINE}

## What it does

- Lists same-stock pools on Solana (Raydium CLMM, Backpack Securities and xStocks tokens) and Robinhood Chain (Uniswap v4 pools with a reviewed StablePairHook, Robinhood and Ondo Global Markets tokens), with fee tier, TVL and 24h volume.
- Suggests a range: on Solana the app prices range presets (Micro, Tight, Standard, Wide) against the last 7 full days of volume and current liquidity. You can override the suggestion.
- Opens the position: if your wallet does not hold the two tokens in the right ratio, part of the deposit is swapped into the pool tokens first. Solana transactions are simulated again before they are sent.
- Manages the position: on Solana, add liquidity, compound collected fees back into the position, or withdraw at any time; on Robinhood Chain, close the position at any time, which returns both pool tokens and the fees it has collected.
- Wallets: for Solana pools, a Solana browser wallet such as Phantom (any wallet the browser exposes through the Wallet Standard); for Robinhood Chain, an EVM browser wallet found through EIP-6963 (MetaMask listed first) or the browser's default injected wallet.
- Works with AI agents (Solana only): an MCP server lets an AI assistant list Solana pools, quote, and prepare unsigned, simulated transactions to open, add to, compound or withdraw a Raydium position. Your wallet signs each one. Robinhood Chain pools are not available through MCP.
- SoFinance does not move or re-center your range automatically. If price leaves your range, you decide whether to wait, change range, or withdraw.

## How LP fees work here

- Traders who swap through a pool pay that pool's fee. Liquidity providers whose range contains the current price share those fees in proportion to their active liquidity.
- Out of range means no fees: while the pool price is outside your range, that position collects nothing until price comes back or you change range.
- Same-stock pools usually trade close to 1:1, which allows narrow ranges. Narrow ranges show a higher estimated fee APR and leave range sooner.
- Pool fee APR = (24h pool fees / TVL) x 365. It is a pool-level, gross estimate from a recent window, not a personal result, and it ignores impermanent loss and costs. The Robinhood Chain hook fee is dynamic, so its estimate uses the current fee rate.

## Costs

- SoFinance protocol fee: 10 basis points (0.10%), only when a swap is made for you, taken inside the transaction you sign.
  - Solana: on the swapped part of a deposit when opening or adding (in the input token), on harvested tokens swapped when compounding, and on tokens converted when withdrawing to USDC or another single token. Withdrawing as the two original tokens: no SoFinance fee.
  - Robinhood Chain: on the tokens the swap returns when opening a position. Closing a position: no SoFinance fee; it returns the two pool tokens (no convert-to-USDC exit).
- Network fees, plus on Solana small account deposits that mostly come back when you close the position.
- Swap route costs and price impact; swaps have a price-protection limit and fail rather than fill worse.

## Risks

- Liquidity providing is not risk-free. You can end up with less value than if you had held the tokens.
- The two versions of the same stock can trade at a temporary premium or discount to each other; the token mix in your position shifts as price moves (impermanent loss).
- Out of range: no trading fees collected.
- Smart contract risk in Raydium, Uniswap v4 and its hooks, Jupiter, token programs and related onchain programs.
- Regional restrictions: token issuers and venues restrict who may hold or trade these assets (for example, xStocks are not offered to US persons). That is outside SoFinance's control.

## Supported pools

Live list: ${url(APP_ROUTES.rwaPairs)} (it changes as pools are created or delisted). As of ${FAQ_POOLS_AS_OF}:

Solana (Raydium CLMM):
${SOLANA_POOLS.map((pool) => `- ${pool}`).join("\n")}

Robinhood Chain (Uniswap v4, StablePairHook, 11 pools):
${ROBINHOOD_CHAIN_POOLS.map((pool) => `- ${pool}`).join("\n")}

## Docs

${docs.join("\n")}
- [FAQ](${url(FAQ_ROUTE)}): plain answers on LP fees, tokenized stocks and buying stocks onchain

## Optional

- [App: same-stock pools](${url(APP_ROUTES.rwaPairs)})
- [Use with an AI agent (MCP)](${url(APP_ROUTES.ai)})
${blog.join("\n")}
- [X: @SoFinancelab](${SOCIAL_LINKS.x.href})
`;
}
