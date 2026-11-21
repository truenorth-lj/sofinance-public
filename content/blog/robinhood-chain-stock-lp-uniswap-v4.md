---
title: "Robinhood Chain stock LP: same-stock pools on Uniswap v4, explained"
description: "How liquidity providing works for tokenized stocks on Robinhood Chain: Robinhood Stock Tokens paired with Ondo Stocks in Uniswap v4 StablePair pools, such as NVDA/NVDAon, what you need, the costs, and the risks."
datePublished: "2026-11-21"
dateModified: "2026-11-21"
hero:
  src: /blog/robinhood-chain-stock-lp-uniswap-v4/hero.png
  alt: Card showing a Robinhood Stock Token and an Ondo Stocks token for the same share paired in a Uniswap v4 StablePair pool on Robinhood Chain
faq:
  - question: "What is Robinhood Chain?"
    answer: "Robinhood Chain is a permissionless, Ethereum-compatible Layer 2 built on Arbitrum's platform and designed for tokenized real-world assets such as stocks and ETFs. Its public mainnet launched on 1 July 2026. It uses ETH for gas and has chain ID 4663."
  - question: "What is a same-stock pool on Robinhood Chain?"
    answer: "It is a Uniswap v4 pool that pairs a Robinhood Stock Token with the Ondo Stocks token for the same share, for example NVDA with NVDAon. Both track the same stock, so the pool usually trades close to the fair ratio, and liquidity providers collect the swap fees while their range is active."
  - question: "Which Robinhood Chain same-stock pools does SoFinance support?"
    answer: "As of 21 November 2026, eleven Uniswap v4 StablePair pools: SPCX, NVDA, SPY, META, GOOGL, AAPL, MSTR, CRCL, TSLA, QQQ and GME, each paired with its Ondo Stocks version (for example TSLA/TSLAon)."
  - question: "What wallet do I need?"
    answer: "An EVM browser wallet, such as MetaMask, with some ETH on Robinhood Chain for network fees. SoFinance asks the wallet to switch to or add Robinhood Chain when you connect."
  - question: "Can I compound fees on Robinhood Chain positions?"
    answer: "Not in SoFinance today. One-click compound is available for Raydium and Meteora positions on Solana. A Robinhood Chain position can be closed at any time, which returns both pool tokens and the fees it collected."
  - question: "What does it cost?"
    answer: "SoFinance charges 0.10% of the tokens a swap returns when part of your deposit is swapped on open; no swap, no fee. Closing costs no SoFinance fee. You also pay network fees in ETH, and the pool's own swap fee, which is set by the StablePair hook and changes over time."
  - question: "Who can hold Robinhood Stock Tokens and Ondo Stocks?"
    answer: "Neither is offered in the United States or to US persons, and both issuers restrict other jurisdictions. Check each issuer's terms for where you live before you buy or deposit."
  - question: "Why is volume in Robinhood Chain pools low?"
    answer: "These pools are new. On 21 November 2026 they held roughly $27k to $49k each but traded little in 24 hours, so their 7-day estimated fee APRs were close to zero. Volume can change; fee estimates follow it. Fees not guaranteed."
---

Most same-stock liquidity today is on Solana, where Backpack Securities tokens and xStocks trade against each other on Raydium and Meteora. Robinhood Chain now has its own version: Robinhood Stock Tokens paired with Ondo Stocks in Uniswap v4 pools. This post explains how those pools work, what you need to provide liquidity in them, and what to watch out for.

Facts were checked against Robinhood, Ondo and Uniswap sources and our own pools page on 21 November 2026 (UTC).

**Disclosure:** we build SoFinance, which lists and opens these Robinhood Chain pools. We are not affiliated with Robinhood, Ondo or Uniswap.

## What Robinhood Chain is

Robinhood Chain is a permissionless, Ethereum-compatible Layer 2 built on Arbitrum's platform, aimed at tokenized real-world assets such as stocks and ETFs. Its public mainnet launched on 1 July 2026. Useful details:

- Gas is paid in **ETH**.
- Chain ID **4663**; block explorer **robinhoodchain.blockscout.com**.
- Any EVM wallet can connect. The Robinhood Wallet supports it natively.
- It is separate from Robinhood's brokerage app; activity on the chain does not touch a brokerage account.

## The two tokens in each pool

- **Robinhood Stock Tokens**, issued by Robinhood Assets (Jersey) Limited. Robinhood describes them as tokenised debt securities that give economic exposure to the underlying share but no legal or beneficial rights in it.
- **Ondo Stocks** (formerly Ondo Global Markets), marked with an "on" suffix: NVDAon, TSLAon, SPYon. Ondo says they are backed by the underlying shares and can be minted and redeemed by eligible users.

On SoFinance the Robinhood token is shown by its plain ticker (NVDA) and the Ondo token with its suffix (NVDAon). Ondo's own announcement calls the Robinhood side NVDArh.

Ondo announced on 27 October 2026 that its tokens could be bridged to Robinhood Chain and that 11 tickers had Uniswap v4 StablePair pools against Robinhood Stock Tokens. One reason given: those 11 Ondo Stocks can be minted and redeemed around the clock, including weekends, on Ethereum and BNB Chain, while the Robinhood token's mint and redemption window closes at weekends. That gap can make the two versions drift apart for a while, and swaps through the pool are one way traders close it.

## How the pools work

These are Uniswap v4 pools that use a hook called StablePairHook. In plain terms:

- The pool is a concentrated liquidity pool, like Raydium CLMM on Solana. You choose a price range and collect a share of swap fees while the pool price is inside it.
- The fee is **dynamic**: the hook sets it and it changes over time, rather than being a fixed tier such as 0.05%. That is why our pools page shows no fixed fee tier for these pools.
- SoFinance only lists pools that use the reviewed StablePairHook with the expected settings. If a pool's hook or fee configuration differs, it is not listed.

## The pools today

As of 21 November 2026, SoFinance lists eleven Robinhood Chain same-stock pools:

- [SPCX / SPCXon](/pools/spcx-spcxon) (SpaceX)
- [NVDA / NVDAon](/pools/nvda-nvdaon) (Nvidia)
- [SPY / SPYon](/pools/spy-spyon) (S&P 500 ETF)
- [META / METAon](/pools/meta-metaon) (Meta)
- [GOOGL / GOOGLon](/pools/googl-googlon) (Alphabet)
- [AAPL / AAPLon](/pools/aapl-aaplon) (Apple)
- [MSTR / MSTRon](/pools/mstr-mstron) (Strategy)
- [CRCL / CRCLon](/pools/crcl-crclon) (Circle)
- [TSLA / TSLAon](/pools/tsla-tslaon) (Tesla)
- [QQQ / QQQon](/pools/qqq-qqqon) (Nasdaq-100 ETF)
- [GME / GMEon](/pools/gme-gmeon) (GameStop)

On our [pools page](/pools) at about 15:20 UTC that day, each held roughly $27k to $49k of liquidity, but 24-hour volume was small, from $0 to about $480. With so little trading, the 7-day estimated fee APRs (for a $1,000 deposit in the best range) were close to zero, at most 0.03%. That is the honest picture of a new venue: liquidity is there, trading is not yet. Not a prediction. Fees not guaranteed.

## How to open a position

You need an EVM browser wallet with a stock token you hold on Robinhood Chain and a little ETH for gas.

1. Open the [pools page](/pools) and pick a Robinhood Chain pool, for example [NVDA / NVDAon](/pools/nvda-nvdaon).
2. Connect your EVM wallet. SoFinance looks for wallets that announce themselves (MetaMask is listed first) and asks yours to switch to or add Robinhood Chain.
3. Enter what you want to deposit. If you hold only one of the two tokens, part of it is swapped into the other. Swaps have a 0.05% price-protection limit; if the price moves more than that, the swap fails rather than filling worse.
4. Review the preview, including the 0.10% SoFinance fee on the tokens the swap returns (only if a swap is made), then sign in your wallet.

The position is a standard Uniswap v4 position in your wallet. SoFinance never holds your keys or tokens.

## Managing and closing

- **Close at any time.** Closing returns both pool tokens and the fees the position collected. SoFinance charges no fee to close. There is no convert-to-USDC exit on Robinhood Chain.
- **No compound today.** One-click compound is available for Raydium and Meteora positions on Solana, not for Robinhood Chain. See [How to compound LP trading fees](/blog/compound-lp-trading-fees-raydium-meteora) for how it works on Solana.
- **No AI agent support.** Our MCP server covers Solana pools only.
- **Out of range.** As on any concentrated pool, a position collects no fees while the price is outside its range. See [LP position out of range](/blog/lp-position-out-of-range).

## Risks

- **Stock price.** Both tokens track the same stock, so the position's dollar value moves with the share price.
- **Issuer gaps.** The Robinhood and Ondo versions can trade at a premium or discount to each other, especially when one issuer's mint and redemption window is closed. That shifts your position toward the cheaper token (impermanent loss).
- **Two issuers, two structures.** The tokens have different legal structures and issuer controls. Read both issuers' terms.
- **Smart contracts.** Uniswap v4, the StablePairHook, the token contracts and bridges can have bugs.
- **Eligibility.** Neither token is offered in the United States or to US persons, and both issuers restrict other jurisdictions.

## FAQ

### What is Robinhood Chain?

Robinhood Chain is a permissionless, Ethereum-compatible Layer 2 built on Arbitrum's platform and designed for tokenized real-world assets such as stocks and ETFs. Its public mainnet launched on 1 July 2026. It uses ETH for gas and has chain ID 4663.

### What is a same-stock pool on Robinhood Chain?

It is a Uniswap v4 pool that pairs a Robinhood Stock Token with the Ondo Stocks token for the same share, for example NVDA with NVDAon. Both track the same stock, so the pool usually trades close to the fair ratio, and liquidity providers collect the swap fees while their range is active.

### Which Robinhood Chain same-stock pools does SoFinance support?

As of 21 November 2026, eleven Uniswap v4 StablePair pools: SPCX, NVDA, SPY, META, GOOGL, AAPL, MSTR, CRCL, TSLA, QQQ and GME, each paired with its Ondo Stocks version (for example TSLA/TSLAon).

### What wallet do I need?

An EVM browser wallet, such as MetaMask, with some ETH on Robinhood Chain for network fees. SoFinance asks the wallet to switch to or add Robinhood Chain when you connect.

### Can I compound fees on Robinhood Chain positions?

Not in SoFinance today. One-click compound is available for Raydium and Meteora positions on Solana. A Robinhood Chain position can be closed at any time, which returns both pool tokens and the fees it collected.

### What does it cost?

SoFinance charges 0.10% of the tokens a swap returns when part of your deposit is swapped on open; no swap, no fee. Closing costs no SoFinance fee. You also pay network fees in ETH, and the pool's own swap fee, which is set by the StablePair hook and changes over time.

### Who can hold Robinhood Stock Tokens and Ondo Stocks?

Neither is offered in the United States or to US persons, and both issuers restrict other jurisdictions. Check each issuer's terms for where you live before you buy or deposit.

### Why is volume in Robinhood Chain pools low?

These pools are new. On 21 November 2026 they held roughly $27k to $49k each but traded little in 24 hours, so their 7-day estimated fee APRs were close to zero. Volume can change; fee estimates follow it. Fees not guaranteed.

## Sources

- Robinhood newsroom, [Robinhood Chain mainnet, Stock Tokens](https://robinhood.com/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/) (1 July 2026)
- Robinhood support, [Robinhood Chain](https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/) and [Robinhood Chain docs](https://docs.robinhood.com/chain/)
- Ondo Finance, [Ondo Stocks are live on Robinhood Chain with Uniswap StablePair pools](https://ondo.finance/blog/ondo-stocks-live-on-robinhood-chain-and-uniswap) (27 October 2026) and [Ondo Stocks](https://ondo.finance/ondo-stocks)
- [SoFinance pools page](/pools), read 21 November 2026, about 15:20 UTC; [Pricing](/fees); [Risks](/docs/risks)

---

*Data checked on 21 November 2026 (UTC). Liquidity providing can lose money. Not financial advice. Not a prediction. Fees not guaranteed.*
