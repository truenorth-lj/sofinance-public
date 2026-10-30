---
title: "From x·y=k to Oracle Pools: How On-Chain Market Making Learned to Live With Negative Gamma"
description: "Constant-product AMMs, concentrated liquidity, active vaults, option hedges, proactive and oracle-priced pools, dynamic-fee hooks, and correlated pairs, compared side by side."
datePublished: "2026-10-23"
dateModified: "2026-10-23"
hero:
  src: /blog/dex-evolution/hero-evolution.png
  alt: Three stages of on-chain market making
---

Every DEX liquidity provider is quietly running a trade. You may not think of depositing two tokens into a pool as "selling volatility", but the payoff says you are. This piece walks through how on-chain market making has evolved, why the basic LP position loses value when prices move, and the different ways protocols and LPs have tried to deal with that.

We try to keep it neutral. Every design below solves some problems and creates others. The last section introduces what our team is building, and it is clearly marked.

---

## 1. Passive AMMs: the price is whatever the pool says it is

### Uniswap V2: x · y = k

The original constant-product market maker holds two reserves, x and y, and lets anyone trade as long as their product k stays constant (before fees). The price is just the ratio of the reserves. Nobody quotes it; it moves only when someone trades.

That design is elegant and fully permissionless, but it has a built-in cost. When the "real" price moves on a centralized exchange or another venue, the pool doesn't know. Arbitrageurs trade against it until the ratio catches up, and every one of those trades is the pool selling the asset that just went up and buying the one that just went down.

The result is the familiar **impermanent loss (IL)**: compared with simply holding the two tokens, the LP ends up with less value. For a constant-product pool, if one token's price changes by a factor r against the other, the LP position is worth 2√r / (1 + r) of the HODL portfolio. A 25% move costs about 0.6% versus holding. A 2x move costs about 5.7%. Fees have to cover that.

### Concentrated liquidity: Uniswap V3 and PancakeSwap V3

Uniswap V3 (and CLMM designs like PancakeSwap V3 and Raydium CLMM) let LPs put liquidity in a chosen price range instead of across all prices. Inside that range, the same dollar provides far more depth, so a tight range can collect far more fees per dollar.

The trade-off is that concentration works like leverage on the same exposure. The narrower the range, the faster the position converts from one token into the other as price moves, and the larger the IL for the same move. If price leaves the range, the position becomes 100% one token, and it stops collecting fees until price comes back or the LP moves the range. That is the **out-of-range** problem.

### Why an LP is short gamma

![Concave LP payoff vs HODL](/blog/dex-evolution/payoff-gamma.png)

Plot an LP position's value against the asset price and you get a curve that bends downward (concave). HODL is a straight line. The LP curve touches the HODL line at the entry price and sits below it everywhere else. In options language, that shape is **negative gamma**: you are effectively short volatility.

The analogy is direct. Panoptic's documentation describes a concentrated-liquidity position as mathematically equivalent to a short put. A short option holder collects premium (theta) and loses when the market moves a lot. An LP collects trading fees and loses to large moves. **Fees play the role of theta; IL is the gamma bill.**

### LVR: the cost, measured properly

IL compares the LP with holding, and it can "come back" if price returns. A sharper measure came from Milionis, Moallemi, Roughgarden and Zhang's 2022 paper on **loss-versus-rebalancing (LVR)**. It compares the pool with a strategy that holds the same inventory but rebalances at market prices.

The insight: because the pool's price is stale between trades, arbitrageurs always trade against it at slightly outdated prices. That leakage doesn't reverse. The paper shows it grows with volatility squared (for a constant-product pool, roughly σ²/8 of pool value per unit of time). If fees don't exceed LVR, the LP is subsidizing arbitrageurs, whatever the headline APR says.

Every design that follows is an attempt to shrink that gap, offset it, or avoid it.

---

## 2. Beating negative gamma: three families of workarounds

### a) Active rebalancing: ALMs and vaults

If out-of-range is the problem, move the range. Active liquidity managers (ALMs) do that for you.

- **Gamma** runs non-custodial, automated rebalancing vaults on Uniswap V3/V4 and Algebra-based DEXs. Its docs say rebalancing logic is computed off-chain and executed on-chain, triggered by price and asset ratios.
- **Arrakis Pro** offers market making for token issuers through self-custodial vaults, with off-chain strategy execution covering rebalancing and dynamic fees.
- **Kamino Liquidity** on Solana runs automated CLMM vaults across Orca Whirlpools, Raydium CLMM and Meteora DLMM, handling rebalancing, compounding and reward collection.

What this solves: positions stay in range, and you don't have to babysit them. What it doesn't solve: rebalancing doesn't remove negative gamma. Re-centering after a move *locks in* the loss that has already happened. Rebalancing also costs swaps and gas, and a vault adds strategy and contract risk.

### b) Buying gamma back: options and power perps

If LP is short gamma, hedge with something long gamma.

- **Squeeth** (Opyn) was a power perpetual tracking ETH², a convex payoff that could offset an LP's concave one. **Note: per Opyn's FAQ, the Squeeth protocol shut down on November 4, 2024.** It remains a useful reference design.
- **Panoptic** builds perpetual options on top of Uniswap liquidity. Option sellers deploy liquidity into a range; option buyers remove it and pay streaming premium ("streamia") while price stays near the strike.
- **GammaSwap** lets traders borrow LP tokens and hold the underlying, creating a position that profits from volatility, the mirror image of an LP. LPs who lend their liquidity receive borrow interest on top of pool fees.

What this solves: you can, in principle, neutralize gamma. What it doesn't: hedges cost money (funding, premium, interest), need sizing and monitoring, and add counterparty and smart-contract layers. Most retail LPs don't run a delta-and-gamma book.

### c) Picking pairs that barely move: correlated and pegged pools

The cheapest way to lower gamma cost is to choose a pair whose relative price doesn't move much: stablecoin/stablecoin, ETH/liquid-staked ETH, or two wrappers of the same asset.

IL depends on the *ratio* between the two tokens, not on either token's dollar price. If both sides track the same thing, the ratio stays near 1. That makes ultra-narrow ranges practical, and narrow ranges collect a lot of fee per dollar when there is steady two-way flow.

The catch: "correlated" isn't "identical." Pegs break, wrappers trade at a premium or discount, and a token can be frozen or redeemed differently from its twin. Risk is reduced, not removed.

---

## 3. Proactive AMMs: let an oracle steer the curve

The next step was to stop letting the pool discover price on its own.

### DODO PMM

DODO's **Proactive Market Maker (PMM)** prices trades around a **guide price i**, which can come from an external oracle, and a **slippage factor k** between 0 and 1. With k = 1 the curve matches a constant-product AMM; with k = 0 it becomes a fixed price; values in between concentrate liquidity near i. In DODO V2 private pools, market makers can update i, k and the fee themselves.

Because the curve re-centers on the guide price, arbitrageurs have less stale price to trade against. In exchange, the pool depends on the quality and timeliness of i.

### WOOFi sPMM

WOOFi's **synthetic Proactive Market Making (sPMM)** aims to simulate a centralized-exchange order book on-chain. Its custom oracle (Wooracle) publishes a mid-price, a spread and a liquidity coefficient, with Chainlink feeds as a fallback check. Trades execute around that quote rather than along a reserve curve.

The design is a clear win for depth on major pairs, and it shows where the risk moves: from LVR to **oracle and parameter risk**. WOOFi published a post-mortem after a March 5, 2024 exploit on Arbitrum. A pricing error on the WOO pool, combined with low liquidity and a missing Chainlink fallback for that token, let an attacker trade at an extreme price. WOOFi paused swaps within about 13 minutes. The lesson applies to every oracle-driven design: guardrails matter as much as the price source.

---

## 4. Oracle-priced active pools: Metric

Metric (@metricxyz) takes the proactive idea further and **separates pricing from liquidity** completely. Its docs call these **active pools**. Metric's site lists it as live on Ethereum, BNB Chain and Robinhood Chain, with core contracts audited by Zellic and Sherlock.

**How it works:**

- A **Price Provider** sets a **bid, an ask and a reference price**, from oracles (Chainlink, Pyth, or Metric's gas-optimized Compressed Oracle for market makers' own quotes), on-chain data or custom rules.
- Liquidity sits in **bins**: percentage ranges above and below the reference (for example +1% to +2%). LPs choose which bins to fund.
- Trades move the pool's *deviation* from the reference, not the reference itself. **When the reference moves, the bins move with it.** Nobody has to trade for that to happen.
- A **curator** chooses the Price Provider and pool settings, arranges price updates, and receives a configured share of the spread. In the Metric app, only Metric-verified admins are labeled curators; others show as operators.

Metric's glossary says its pools don't have IL "as long as their reference keeps up with the market." LPs collect **Edge**, their share of the spread measured against the reference. The docs are also direct that price moves on the inventory you hold can outweigh Edge, and that you can lose your entire deposit.

**Safeguards the docs describe:**

- **Staleness limits.** Each Price Provider has a staleness limit, capped at up to 7 days at creation. Until it's reached, the pool trades on the latest stored update. After that, swaps revert. Pools in Metric's top "Best Practices" tier must use 15 seconds or less. When a provider halts, swaps stop, while deposits and withdrawals still work (subject to the pool's extensions).
- **Anchored pricing.** An Anchored Price Provider bounds a curator's bid and ask against an independent Chainlink or Pyth feed, so a bad or malicious quote can only be so far off.
- **StopLoss.** An extension that limits how fast a bin can lose value per LP share. It rejects trades; it doesn't sell positions, and Metric says it doesn't cap all losses.
- **Multiplier Oracle for tokenized stocks.** It prices a stock token as the Pyth share price × the issuer's multiplier, so dividends and splits don't make the pool drift. While an issuer's pause flag is set (for example, around a split), the feed stalls, swaps halt and withdrawals stay open. Per the deployments page, it is deployed on Base and Robinhood Chain.

**The remaining risk: pick-offs.** A trade that lands before the maker's newest update uses older data. If that quote is better for the taker, the difference comes out of the pool. That can happen *within* the staleness limit. Metric's docs call keeping prices fresh "the curator's job" and describe chain-specific ordering arrangements with block builders to reduce it. In short: LVR becomes latency risk, and the curator carries much of the burden.

---

## 5. Smarter fees on a classic curve: Fables

Fables (@fablesfi) takes a different route. It keeps concentrated liquidity and changes the **fee**.

Fables is a non-custodial DEX on **Robinhood Chain**, built on **Uniswap v4 hooks**, with markets for crypto, tokenized stocks, ETFs and stablecoins. Its docs describe per-pool dynamic fees: each pool has an on-chain baseline (a calendar schedule or a resting fee), and an authorized off-chain keeper can apply temporary fee changes within configured bounds. Third-party summaries (DefiLlama, Hoodscan) describe stock pools as calendar-based, with higher fees around market closes, overnight and on weekends, and crypto pools as volatility-based.

The logic is straightforward: charge more when a trade is more likely to be informed (for example, when the underlying stock market is closed and the on-chain price can't be checked against it), and less when flow is benign. Higher fees at risky moments mean LPs are paid more for the gamma they're short.

Fables also runs a **ve(3,3)** incentive model. Its FABLES token launched on October 20, 2026, and Fables posted that eligible LP positions can now be staked to receive FABLES emissions *instead of* swap fees, with lockers voting on how emissions are directed across pools.

The honest framing: the LP position is still a concentrated-liquidity range, so it is **still short gamma** and can still go out of range. Dynamic fees and emissions *offset* that cost rather than remove it. Whether the offset is enough depends on the pool, the period and the token's value.

---

## 6. Side by side

![How liquidity behaves when price moves](/blog/dex-evolution/liquidity-behavior.png)

![Approaches compared](/blog/dex-evolution/comparison-table.png)

| Approach | Price source | How liquidity moves | Who controls pricing | Main LP risk | Operator burden |
|---|---|---|---|---|---|
| Constant product (Uniswap V2) | Pool reserves | Never; spread across all prices | Nobody (arbitrage) | IL / LVR, low capital efficiency | None |
| Concentrated liquidity (Uniswap V3, PancakeSwap V3, Raydium CLMM) | Pool reserves | Fixed range set by the LP | Nobody (arbitrage) | Amplified IL/LVR, out-of-range | High if self-managed |
| ALM vaults (Gamma, Arrakis, Kamino) | Pool reserves | Vault re-ranges on triggers | Pool + vault strategy | Realized IL on rebalances, strategy and contract risk | Low for the LP, high for the manager |
| Gamma hedges (Panoptic, GammaSwap; Squeeth, now shut down) | Pool reserves | LP range unchanged; hedge on top | Nobody (arbitrage) | Hedge cost, sizing, extra protocol risk | High |
| Correlated / same-asset pairs on CLMM | Pool reserves | Narrow fixed range near 1:1 | Nobody (arbitrage) | De-peg / premium, issuer risk, out-of-range | Low to medium |
| DODO PMM | Guide price i (can be an oracle) | Curve re-centers on i | Pool creator / market maker (i, k) | Oracle / parameter risk | Medium to high |
| WOOFi sPMM | Wooracle (+ Chainlink fallback) | Quotes follow the oracle | WOOFi | Oracle / parameter risk | Handled by the protocol |
| Metric active pools | Price Provider (oracle, MM quotes, rules) | Bins move with the reference | Curator, within anchors and safeguards | Pick-offs / stale quotes, curator risk, inventory | High for curators, lower for LPs |
| Fables (v4 hooks) | Pool reserves; fees from calendar / volatility | Fixed range set by the LP | Nobody for price; keeper for fees within bounds | Still short gamma; offset by fees and emissions | Medium |

A pattern stands out. Moving from left to right in the evolution, risk doesn't disappear. It **moves**: from LPs paying arbitrageurs (LVR) to LPs trusting a price source and whoever operates it (oracle, curator, keeper). That can be a very good trade, but it is a trade.

---

## 7. Where SoFinance fits

*This section is about our own product. Everything above is independent of it.*

SoFinance (sofinancelab.xyz) is a self-custody app on Solana for one specific corner of the map above: **same-stock tokenized-stock pools on Raydium CLMM.** These are pools where both tokens represent the same stock from different issuers, for example an xStocks token against a Backpack-issued token of the same share: SPCXx/SPCX, METAx/META ($META), and pairs for $HOOD, $MSTR, $AMD, $SNDK and $TSLA.

**Why same-stock pools.** This is the correlated-pair idea from section 2. Both tokens track the same stock, so the pool price is a ratio that sits near 1:1 regardless of where the stock itself goes. That lowers the gamma cost a lot compared with a stock/USDC pool, and it makes narrow ranges practical. It doesn't remove it. The two issuers' tokens can trade at a premium or discount to each other. Issuers can freeze tokens or change terms. Price can still leave your range, and then the position stops collecting fees.

**What the app does.**

- You enter **one SOL or USDC amount**. SoFinance routes the swap through **Jupiter** into both sides of the pair and opens the Raydium CLMM position in **one atomic v0 transaction**. The transaction is **simulated before you sign** and **re-simulated before it's broadcast**.
- On Solana, it prices **four range candidates (Micro, Tight, Standard, Wide)** against the pool's **last ~7 days of volume** and picks the range with the best backtest result, so you don't have to do range research yourself. You can override it and set your own range.
- **One-click compound** and **one-click withdraw**.
- The **position NFT sits in your wallet**. It's a standard Raydium position. You can manage it in SoFinance or directly on Raydium.

**What it doesn't do.** SoFinance doesn't change the AMM. It doesn't price from an oracle like Metric, and it doesn't set dynamic fees like Fables. It doesn't automatically rebalance or re-center your position either. The pool, its fee tier and its arbitrage flow are all Raydium's. What we do is turn the correlated-pair approach on existing Raydium CLMM pools into a single transaction with a backtested range.

**Numbers, honestly.** Any APR you see in the app is an **estimate over a stated window (24h of pool fees, or on Solana a 7-day backtest for range estimates), not a guarantee**. Many of these pools are small, so a sizable deposit can change the result a lot. Estimates ignore IL and your trading costs.

**Costs.** The hosted app charges a disclosed **10 bps (0.10%) protocol fee** on the token you deposit (open, add, and compound reinvest), shown in the preview in that token and visible on-chain. Withdraw-to-USDC still takes the same 10 bps as a conversion fee in USDC. There is no performance fee on LP earnings. Normal Solana network fees and swap-route costs apply.

**Risks to weigh.** These include IL and issuer premium/discount moves, out-of-range periods with no fees, Token-2022 freeze authority and other issuer controls, smart-contract risk across Raydium, Jupiter and token programs.

SoFinance isn't affiliated with Metric, Fables, Raydium, Jupiter, xStocks, Backpack or any token issuer.

If you hold a tokenized stock and want to see what a same-stock pool looks like, including its backtested ranges (Solana pools) and risk flags, before you commit anything:

**[https://sofinancelab.xyz/app/rwa-pairs?ref=x-article](https://sofinancelab.xyz/app/rwa-pairs?ref=x-article)**

*Not financial advice. Providing liquidity can lose money.*
