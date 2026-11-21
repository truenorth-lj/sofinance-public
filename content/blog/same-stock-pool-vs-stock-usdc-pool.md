---
title: "Same-stock pool vs stock/USDC pool: impermanent loss and range math for tokenized stocks"
description: "TSLAx/USDC or TSLAx/TSLA? A side-by-side look at how a stock/USDC liquidity pool and a same-stock pool behave when the stock moves, with worked impermanent loss numbers, out-of-range risk and live pool data."
datePublished: "2026-11-21"
dateModified: "2026-11-21"
hero:
  src: /blog/same-stock-pool-vs-stock-usdc-pool/hero.png
  alt: Comparison card of a stock/USDC pool and a same-stock pool, showing illustrative impermanent loss for a stock move versus a small move between two issuers of the same stock
faq:
  - question: "What is the difference between a same-stock pool and a stock/USDC pool?"
    answer: "A stock/USDC pool pairs a tokenized stock with a dollar stablecoin, so the pool price is the stock price. A same-stock pool pairs two tokens of the same stock from different issuers, such as TSLA and TSLAx, so the pool price is one version priced in the other and usually stays near the fair ratio."
  - question: "Which has less impermanent loss?"
    answer: "Usually the same-stock pool, because impermanent loss comes from the relative price of the two tokens moving, and two versions of the same stock usually move together. A stock/USDC pool has impermanent loss every time the stock moves against the dollar."
  - question: "Does a same-stock pool protect me if the stock falls?"
    answer: "No. Both tokens track the stock, so the dollar value of the position rises and falls with the share price. A same-stock pool reduces impermanent loss between the two tokens; it does not remove stock price risk."
  - question: "Does a stock/USDC pool reduce my stock exposure?"
    answer: "Partly. About half the value can sit in USDC inside the range, so the position has less stock exposure than holding only the stock. As the stock falls the pool buys more of it, and as it rises the pool sells it, which is where impermanent loss comes from."
  - question: "Which pool collects more trading fees?"
    answer: "It depends on volume, fee tier, your range and your share of liquidity, not on the pool type. Some stock/USDC pools have far more liquidity and volume than same-stock pools; some same-stock pools have high volume relative to their size. Compare the live pool data. Fees not guaranteed."
  - question: "Why can same-stock pools use such tight ranges?"
    answer: "Because the pool price is the ratio between two tokens of the same share, which usually moves by fractions of a percent. A stock/USDC price can move several percent in a day, so the same tight range would be out of range quickly."
  - question: "Can a same-stock pool still lose money?"
    answer: "Yes. The stock can fall, the two issuers can trade at a premium or discount to each other, the position can go out of range, issuers can freeze Token-2022 tokens, and smart contract risk applies."
---

If you hold a tokenized stock such as TSLAx and want to provide liquidity, there are two common setups on Solana: pair it with a dollar stablecoin (TSLAx/USDC), or pair it with another issuer's version of the same stock (TSLAx/TSLA). They behave very differently when the stock moves.

This post compares the two with plain math and live pool data from 21 November 2026 (UTC). It is not a recommendation for either.

**Disclosure:** we build SoFinance, a self-custodial tool for same-stock pools. We do not support stock/USDC pools, so we have tried hard to be fair to both.

## The one difference that matters: what the pool price measures

- In a **stock/USDC pool**, the pool price is the stock's price in dollars. When Tesla moves 5%, the pool price moves 5%.
- In a **same-stock pool**, the pool price is one Tesla token priced in another Tesla token. When Tesla moves 5%, both tokens move about 5%, and the pool price barely moves. It only moves when one issuer's token trades at a premium or discount to the other.

Almost everything else follows from this.

## Impermanent loss, worked through

Impermanent loss (IL) is the gap between the value of your LP position and the value you would have had by simply holding the tokens you deposited. It comes from the relative price of the two tokens moving, because the pool sells the side that rises and buys the side that falls.

The numbers below are textbook concentrated-liquidity math for a position centred on the starting price. They are illustrative, not data from any real position, and they leave out fees and costs.

**Stock/USDC pool, range ±10% around the starting price:**

| Stock price move | IL vs holding |
|---|---|
| +5% | -0.61% |
| -5% | -0.67% |
| +10% (top of range) | -2.32% |
| -10% (bottom of range) | -2.83% |

**Same-stock pool, range ±0.3% around the fair ratio:**

| Move between the two issuers | IL vs holding |
|---|---|
| 0.1% | -0.008% |
| 0.2% | -0.03% |
| 0.3% (edge of range) | -0.07% |

The same-stock range is more than thirty times narrower, yet the IL at the edge is far smaller, because the thing that causes IL (a move between the two tokens) is much smaller. The catch is that a 0.3% move between issuers is enough to take that tight range out of range. A ±1% range would stay in range through that move, with even less IL per move, but it spreads the deposit thinner.

For a fuller explanation, see [Impermanent loss on same-stock pools](/learn/impermanent-loss-on-same-stock-pools).

## What IL does not tell you: dollar value

IL is measured against holding the same tokens. It does not say whether you made or lost money in dollars.

- In a **same-stock pool**, both tokens are Tesla. If Tesla falls 10%, the position falls about 10% in dollars, even with almost no IL. A same-stock pool is not a hedge.
- In a **stock/USDC pool**, part of the value sits in USDC, so a 10% fall hurts the position less than holding only the stock. But as the stock falls, the pool buys more of it with your USDC, and if the stock leaves the bottom of your range, you hold only the stock.

So the choice is partly about what exposure you want. A same-stock pool keeps you fully in the stock and adds trading fees on top. A stock/USDC pool gives you a mix of stock and dollars that shifts as the price moves.

## Out-of-range time

A concentrated position collects trading fees only while the pool price is inside its range. See [LP position out of range](/blog/lp-position-out-of-range).

- A stock/USDC range has to be wide enough to hold through normal stock moves, which can be several percent in a day.
- A same-stock range can be much tighter, because the ratio between two versions of the same stock usually stays in a narrow band. Very tight ranges still leave range on issuer premiums or discounts, weekend gaps, and corporate actions such as [xStocks multiplier updates](/blog/xstocks-multiplier-explained).

## Liquidity and volume: live numbers

Fees come from volume. Neither pool type wins by default. Here are real numbers from two public sources on 21 November 2026, around 15:20 UTC:

| Pool | Source | Liquidity / TVL | 24h volume |
|---|---|---|---|
| TSLAx / USDC, Raydium (largest listed) | DexScreener | $2.15M | $1.97M |
| TSLAx / TSLA, Meteora DLMM (1 bps) | [SoFinance pools page](/pools/tsla-tslax-meteora) | $43.8k | $399.5k |
| TSLAx / TSLA, Raydium CLMM (5 bps) | [SoFinance pools page](/pools/tsla-tslax) | $1.0k | $2.4k |

The biggest TSLAx/USDC pool is far deeper. The Meteora same-stock pool is much smaller but traded about nine times its TVL that day. A single day is noisy, which is why our pool pages use a 7-day window: on the same snapshot, the pools page showed a 7-day estimated fee APR of 28.80% for a $1,000 deposit in the best range on the Meteora TSLAx/TSLA pool. That figure is from the past 7 days' volume and LP net fees, changes daily, and ignores IL and costs. Not a prediction. Fees not guaranteed.

## Side by side

| | Stock/USDC pool | Same-stock pool |
|---|---|---|
| Pool price | Stock in dollars | One issuer's token in the other's |
| Typical relative move | Same as the stock | Fractions of a percent |
| Impermanent loss | Every time the stock moves | Only on issuer premium or discount |
| Dollar exposure | Mix of stock and USDC, shifting | Fully in the stock |
| Range width needed | Wide | Can be narrow |
| Main extra risks | Stock moves, out of range | Stock moves, issuer gaps, out of range |
| Issuer risk | Stock issuer and stablecoin issuer | Two stock issuers |

## Which fits which LP?

- If you want to keep full exposure to a stock you already hold and collect trading fees on top, a same-stock pool matches that goal more directly.
- If you want part of the position in dollars and accept IL as the stock moves, a stock/USDC pool matches that goal.
- In both cases, fees depend on volume and your range, and the position can lose money. Start small.

To see the same-stock pools we support, with TVL, 24-hour volume and a 7-day estimated fee APR for each, open the [pools page](/pools). For how a same-stock pool works from the ground up, read [What is a same-stock LP pool?](/learn/what-is-a-same-stock-lp-pool).

## FAQ

### What is the difference between a same-stock pool and a stock/USDC pool?

A stock/USDC pool pairs a tokenized stock with a dollar stablecoin, so the pool price is the stock price. A same-stock pool pairs two tokens of the same stock from different issuers, such as TSLA and TSLAx, so the pool price is one version priced in the other and usually stays near the fair ratio.

### Which has less impermanent loss?

Usually the same-stock pool, because impermanent loss comes from the relative price of the two tokens moving, and two versions of the same stock usually move together. A stock/USDC pool has impermanent loss every time the stock moves against the dollar.

### Does a same-stock pool protect me if the stock falls?

No. Both tokens track the stock, so the dollar value of the position rises and falls with the share price. A same-stock pool reduces impermanent loss between the two tokens; it does not remove stock price risk.

### Does a stock/USDC pool reduce my stock exposure?

Partly. About half the value can sit in USDC inside the range, so the position has less stock exposure than holding only the stock. As the stock falls the pool buys more of it, and as it rises the pool sells it, which is where impermanent loss comes from.

### Which pool collects more trading fees?

It depends on volume, fee tier, your range and your share of liquidity, not on the pool type. Some stock/USDC pools have far more liquidity and volume than same-stock pools; some same-stock pools have high volume relative to their size. Compare the live pool data. Fees not guaranteed.

### Why can same-stock pools use such tight ranges?

Because the pool price is the ratio between two tokens of the same share, which usually moves by fractions of a percent. A stock/USDC price can move several percent in a day, so the same tight range would be out of range quickly.

### Can a same-stock pool still lose money?

Yes. The stock can fall, the two issuers can trade at a premium or discount to each other, the position can go out of range, issuers can freeze Token-2022 tokens, and smart contract risk applies.

## Sources

- Raydium docs, [Impermanent loss](https://docs.raydium.io/algorithms/impermanent-loss)
- [DexScreener](https://dexscreener.com/) pair search for TSLAx/USDC, read 21 November 2026, 15:24 UTC
- [SoFinance pools page](/pools), read 21 November 2026, about 15:20 UTC
- IL tables: standard concentrated-liquidity formulas, computed by us for a position centred on the starting price

---

*Data checked on 21 November 2026 (UTC). Pool numbers change constantly. Liquidity providing can lose money. Not financial advice. Not a prediction. Fees not guaranteed.*
