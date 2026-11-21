---
title: "LP position out of range on Raydium or Meteora? What it means and what you can do"
description: "Why a concentrated liquidity position goes out of range on Raydium CLMM or Meteora DLMM, what happens to your tokens and trading fees, and the options you have, with same-stock pools like TSLA/TSLAx as the example."
datePublished: "2026-11-21"
dateModified: "2026-11-21"
hero:
  src: /blog/lp-position-out-of-range/hero.png
  alt: Diagram of a concentrated liquidity range showing the in-range zone where a position collects trading fees and the out-of-range zones where it holds one token and collects nothing
faq:
  - question: "What does out of range mean for an LP position?"
    answer: "It means the pool's current price has moved outside the lower and upper price you chose. On Raydium CLMM the current tick is outside your ticks; on Meteora DLMM the active bin is outside your bins. Your position is still open, but none of its liquidity is being used by swaps."
  - question: "Do I still collect trading fees when my position is out of range?"
    answer: "No. A concentrated liquidity position collects trading fees only while the price is inside its range. Fees it collected before it went out of range stay in the position until you claim them or close it."
  - question: "What happens to my tokens when the price leaves my range?"
    answer: "The position ends up holding only one of the two tokens. If the price moved above your range you hold all of one side; if it moved below, all of the other. The amounts stay fixed until the price comes back into range."
  - question: "Will my position come back into range by itself?"
    answer: "It can, if the pool price moves back inside your range. Nothing moves the range for you on Raydium CLMM, on Meteora DLMM by default, or in SoFinance. Whether price comes back is not something anyone can promise."
  - question: "Should I close an out-of-range position and open a new one?"
    answer: "It depends on how far the price moved, how long you are willing to wait, and the costs of closing and reopening (network fees, rent, and any swaps). Closing locks in the token mix you hold at that moment. There is no single right answer."
  - question: "How often do same-stock pools go out of range?"
    answer: "We do not have a measured frequency to quote. Two tokens tracking the same share can have a steadier ratio than a stock priced in USDC, but the selected range and issuer pricing determine whether a position stays active. Very tight ranges can still go out of range during weekend gaps, issuer premiums or discounts, or around corporate actions."
  - question: "Does a wider range help?"
    answer: "A wider range stays in range through bigger moves, but the same deposit is spread thinner, so it collects a smaller share of fees while in range. A narrower range collects a larger share and leaves range sooner."
  - question: "Can I collect the fees from an out-of-range position?"
    answer: "Yes. On Raydium you can collect fees without closing the position, and on Meteora pending fees can be claimed. In SoFinance, withdrawing or closing the position also returns the fees it collected."
---

A concentrated liquidity position works only inside the price range you choose. When the pool price leaves that range, the position is "out of range": it keeps your tokens, but it stops collecting trading fees. This is the single most common surprise for new liquidity providers on Raydium CLMM and Meteora DLMM, and it applies to same-stock pools such as TSLA/TSLAx too.

This post explains what happens, why, and what your options are. We checked the venue docs on 21 November 2026 (UTC).

**Disclosure:** we build SoFinance, a self-custodial tool for same-stock pools on Raydium CLMM, Meteora DLMM and Uniswap v4 on Robinhood Chain. SoFinance does not move your range for you, so everything below applies to positions opened with SoFinance as well.

## What "out of range" means

When you open a concentrated liquidity position, you pick a lower and an upper price. Your liquidity is only used by swaps at prices between those two edges.

- **Raydium CLMM** divides the price line into ticks. If the pool's current tick is outside your position's ticks, Raydium's docs say the position "stops accruing fees until the price returns to its range."
- **Meteora DLMM** divides the price line into bins. Meteora's docs say that when the price moves outside your range, "the position remains open, but that position is no longer contributing active liquidity until price returns or you rebalance."

So "out of range" is not an error and not a closed position. It is a position whose liquidity is parked outside the price where trading is happening.

## What happens to your tokens

Inside the range, every swap through your liquidity shifts the mix of the two tokens you hold. As the price rises toward the top of your range, the position sells one token for the other. When the price crosses the edge, the conversion is complete:

- Price above your range: you hold 100% of one token.
- Price below your range: you hold 100% of the other token.

The amounts then stay fixed. No more swaps touch your position until the price comes back inside the range.

For a same-stock pool like TSLA/TSLAx, both tokens track Tesla, so holding "all of one side" still means holding Tesla exposure. The dollar value of the position still moves with the share price. What changed is which issuer's token you hold.

## What happens to your trading fees

Fees are only shared among liquidity that is active at the current price. While you are out of range, your share is zero.

Fees you collected before the price left your range are not lost. On Raydium CLMM they stay owed to the position until you collect them or close it. On Meteora DLMM the position tracks pending fees for both tokens until you claim them. Neither venue compounds them into the position for you.

## Why same-stock pools go out of range less often, but still do

In a stock/USDC pool, the pool price is the stock price in dollars. If Tesla moves 5% in a day, the pool price moves 5%, and a ±2% range is out.

In a same-stock pool, the pool price is one Tesla token priced in another Tesla token. Both track the same share, so the relative price usually stays in a narrow band near the fair ratio. That is why same-stock pools can use much tighter ranges.

Tight ranges still leave range. Common reasons:

- **Issuer premium or discount.** One issuer's token can trade a little above or below the other when demand, mint and redemption access, or market-maker coverage differ.
- **Weekends and market closures.** The underlying stock market is closed, but tokens trade on-chain. Spreads can widen until the market reopens.
- **Corporate actions.** xStocks use a multiplier for dividends and splits, so the fair ratio between the two tokens can shift. See [our multiplier explainer](/blog/xstocks-multiplier-explained).

## Your options when a position is out of range

There is no single right answer. Here are the choices and what each one costs.

### 1. Wait

The position stays open and costs nothing extra while it waits. If the pool price comes back inside your range, it starts collecting trading fees again. The cost is time with no fees, and there is no promise the price returns.

### 2. Collect the fees you already have

You can take the fees the position collected so far without closing it. On Raydium this is the "Collect fees" action; on Meteora you claim pending fees. Each claim is a transaction with a network fee, so small amounts may not be worth claiming yet.

### 3. Close and open a new range

You withdraw the tokens (all one side, plus any fees) and open a new position around the current price. This locks in the token mix you hold now. You also pay network fees, may pay rent for a new position account (most of it comes back when you close), and if you need the other token you pay swap costs. In SoFinance, opening a new position from one token swaps part of it for you, and the 0.10% protocol fee applies only to the part that is swapped. See [Pricing](/fees).

### 4. Widen the range next time

A wider range stays in range through bigger moves but collects a smaller share of fees per dollar while in range. On Solana, SoFinance scores four range presets (Micro, Tight, Standard and Wide) on the last 7 days of fee data for the amount you enter, and highlights the one with the highest estimated fee APR. You can pick a wider preset if you would rather leave range less often. That estimate is from a 7-day window and assumes recent volume continues. Not a prediction. Fees not guaranteed. See [how estimates work](/docs/fee-apr).

## How to check whether you are in range

- On **SoFinance**, open [Portfolio](/app/portfolio). Each position shows whether it is in range.
- On **Raydium**, open your position from the portfolio page and compare the current price with your min and max price.
- On **Meteora**, the position list shows your bin range against the active bin.

If you are new to ranges, read [How to open an LP position](/learn/how-to-open-an-lp-position) first, then pick a pool from the [pools page](/pools), for example [TSLAx / TSLA on Meteora DLMM](/pools/tsla-tslax-meteora) or [SPCXx / SPCX on Raydium CLMM](/pools/spcx-spcxx-raydium-1bps).

## FAQ

### What does out of range mean for an LP position?

It means the pool's current price has moved outside the lower and upper price you chose. On Raydium CLMM the current tick is outside your ticks; on Meteora DLMM the active bin is outside your bins. Your position is still open, but none of its liquidity is being used by swaps.

### Do I still collect trading fees when my position is out of range?

No. A concentrated liquidity position collects trading fees only while the price is inside its range. Fees it collected before it went out of range stay in the position until you claim them or close it.

### What happens to my tokens when the price leaves my range?

The position ends up holding only one of the two tokens. If the price moved above your range you hold all of one side; if it moved below, all of the other. The amounts stay fixed until the price comes back into range.

### Will my position come back into range by itself?

It can, if the pool price moves back inside your range. Nothing moves the range for you on Raydium CLMM, on Meteora DLMM by default, or in SoFinance. Whether price comes back is not something anyone can promise.

### Should I close an out-of-range position and open a new one?

It depends on how far the price moved, how long you are willing to wait, and the costs of closing and reopening (network fees, rent, and any swaps). Closing locks in the token mix you hold at that moment. There is no single right answer.

### How often do same-stock pools go out of range?

We do not have a measured frequency to quote. Two tokens tracking the same share can have a steadier ratio than a stock priced in USDC, but the selected range and issuer pricing determine whether a position stays active. Very tight ranges can still go out of range during weekend gaps, issuer premiums or discounts, or around corporate actions.

### Does a wider range help?

A wider range stays in range through bigger moves, but the same deposit is spread thinner, so it collects a smaller share of fees while in range. A narrower range collects a larger share and leaves range sooner.

### Can I collect the fees from an out-of-range position?

Yes. On Raydium you can collect fees without closing the position, and on Meteora pending fees can be claimed. In SoFinance, withdrawing or closing the position also returns the fees it collected.

## Sources

- Raydium docs, [CLMM fees and rewards](https://docs.raydium.io/products/clmm/fees) and [Add or remove liquidity](https://docs.raydium.io/user-flows/add-remove-liquidity)
- Meteora docs, [DLMM Dynamic Positions](https://docs.meteora.ag/core-products/dlmm/dynamic-positions)
- xStocks docs, [Dividends and Stock Splits](https://docs.xstocks.fi/docs/dividends-and-stock-splits)
- SoFinance, [Fee APR](/docs/fee-apr), [Risks](/docs/risks) and [Withdraw anytime](/docs/withdraw)

---

*Docs checked on 21 November 2026 (UTC). Liquidity providing can lose money. Not financial advice. Fees not guaranteed.*
