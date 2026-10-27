---
title: "How to collect xStocks xPoints with same-stock LP (SoFinance as the tool)"
description: "Official xPoints ranks providing liquidity highest. How same-stock Raydium CLMM works, why IL is low (not zero), live fee-side numbers, and how SoFinance opens the position — with our referral disclosed."
datePublished: "2026-10-27"
dateModified: "2026-10-27"
hero:
  src: /blog/xstocks-xpoints/hero.png
  alt: xStocks Introducing xPoints announcement
---

xStocks turned listed equities into Token-2022 assets you can hold, lend, and LP on Solana. The issuer's xPoints program tracks that onchain activity and sets your share of **future rewards the program itself has not specified**. Points are not a token, have no stated monetary value, and are not a promise of an airdrop.

@xStocksFi put it plainly when xPoints went live (17 Mar 2026):
> Hold tokenized stocks in your connected wallet, create a position in lending markets, **add liquidity to pools** — and more.
> https://x.com/xStocksFi/status/2033952074463916318

![xPoints are live — @xStocksFi, 17 Mar 2026](/blog/xstocks-xpoints/01_xstocks_xpoints_live.png)

Source: [x.com/xStocksFi/status/2033952074463916318](https://x.com/xStocksFi/status/2033952074463916318)

![Introducing xPoints — xstocks.fi news](/blog/xstocks-xpoints/02_xpoints_announcement.png)

Source: [xstocks.fi/us/news/introducing-xpoints](https://xstocks.fi/us/news/introducing-xpoints)

On the points dashboard the activity ladder is:

1. **Hold** xStocks — base tier
2. **Lend** xStocks as collateral — higher tier
3. **Provide liquidity** in DeFi pools that accept xStocks — **highest tier**

Rates and exact multipliers are set by xStocks and can change. Always check https://defi.xstocks.fi/points for the live rules. Kraken's own FAQ: holding xStocks **on Kraken** does not count toward xPoints — it is an **onchain** program.

## Why LP (and why same-stock)

If your goal is xPoints under the published ladder, liquidity sits at the top. You also **collect trading fees** from swaps that hit your in-range Raydium CLMM position — separate from points.

![xPoints activity tiers — Hold, Lend, Provide liquidity](/blog/xstocks-xpoints/03_xpoints_dashboard.png)

Source: [defi.xstocks.fi/points](https://defi.xstocks.fi/points)

Most xStock LP tutorials point people at FOOx/USDC-style pools. Those work, but the two sides are uncorrelated: stock vs dollar. When the stock moves, classic impermanent loss shows up hard.

**Same-stock pools** pair two tokenized versions of the **same** equity — for example Backpack Securities $SPCX with xStocks $SPCXx on Raydium CLMM. Both legs track the same underlying name, so the pool price usually sits near 1:1 and **impermanent loss is low compared with stock/stable pools**.

Low ≠ zero. Real risks we list in our docs:

- The two wraps can trade at a temporary premium/discount (depeg / basis).
- Concentrated liquidity: **out of range = no trading fees** until price returns or you change range.
- Smart-contract / Raydium / router risk.
- Token-2022 freeze / issuer controls on either mint.
- Small pools: thin liquidity, noisy fee APR, exit cost.

We do **not** auto-rebalance. Your position is a normal Raydium position NFT in **your** wallet.

## What the fee side looks like right now

Numbers from https://sofinancelab.xyz/api/rwa-pairs · **2026-10-27 10:59 Asia/Taipei**.
Est. fee APR = (24h pool fees ÷ TVL) × 365 × 100. **Not LP return. Ignores IL, your range, and rewards.**

![Same-asset RWA pairs on SoFinance — est. fee APR from 24h fees and TVL](/blog/xstocks-xpoints/04_sofinance_rwa_pairs.png)

Source: [sofinancelab.xyz/app/rwa-pairs](https://sofinancelab.xyz/app/rwa-pairs)

![SPCX / SPCXx Raydium CLMM pool](/blog/xstocks-xpoints/07_raydium_pool.png)

Source: [raydium.io CLMM position for SPCX/SPCXx](https://raydium.io/clmm/create-position/?pool_id=DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro)

- $SPCX/$SPCXx (deepest same-stock pool we list): est. fee APR **~19.3%** on the last 24h · TVL ~$261k · 24h vol ~$1.38M · 1 bp fee
- $SNDK/$SNDKx: est. fee APR **~41.9%** (24h) · smaller TVL → noisier
- Thinner names ($NVDA, $TSLA, $AAPL pairs) can print very high 24h fee APR with low TVL — treat those as **noisy**, not a forecast

Refresh the API before you size a position. Past 24h fees are not a guarantee of the next 24h.

## How to open the LP with SoFinance (self-custodial tool)

SoFinance is **not** a broker and **not** the xPoints program. We are a self-custodial UI that builds a Raydium CLMM open-position transaction for same-asset RWA pairs. You sign; keys stay in your wallet.

App flow (matches https://sofinancelab.xyz/docs and /app):

1. **Register for xPoints first** — connect the same Solana wallet at https://defi.xstocks.fi/points and sign. New registrations with no eligible activity within 7 days can be removed. Prefer a wallet that already holds xStocks.
2. Open https://sofinancelab.xyz/app — connect that wallet.
3. Browse **RWA pairs** (https://sofinancelab.xyz/app/rwa-pairs) — same-asset wraps only (e.g. $SPCX ↔ $SPCXx).
4. Pick a pool. The app suggests a backtested range; **you can override**. Preview shows swaps, amounts, round-trip cost, and est. fee APR for that range — estimates, not guarantees. Read https://sofinancelab.xyz/docs/risks.

![estimates from historical data, not a guarantee](/blog/xstocks-xpoints/05_sofinance_pool_preview.png)

Source: [sofinancelab.xyz/app](https://sofinancelab.xyz/app)

5. **Approve once** in your wallet. We re-simulate before send. You receive a standard Raydium position NFT you can also manage on Raydium.
6. Later: add liquidity, compound collected trading fees, or exit from the app — still your signature every time.

**Points caveat (read this):** Official sources say providing liquidity with xStocks ranks highest, and Solflare documents that xStocks inside **Raydium** LP positions remain counted for their boost rules. Our pools put an **xStock on one side** of a Raydium CLMM position, so the xStock leg is the points-relevant side. The Backpack Securities leg is **not** an xStock. xStocks has **not** published a public list that names each SPCXx/SPCX-style same-stock pool. After you open a position, confirm on the points dashboard that the activity shows under liquidity. If it does not, fall back to an xStock pool the dashboard clearly tracks (or hold/lend tiers) — and tell us.

## Our referral link (disclosed)

We participate in the xPoints referral program.
**Our referral link:** [https://defi.xstocks.fi/points?ref=SOFINANCE](https://defi.xstocks.fi/points?ref=SOFINANCE)

Per the live xPoints dashboard FAQ: when someone joins with your link, the referrer gets **20% of the points** their referrals generate, and referred users get a **20% boost** on their points. That wording is from the dashboard FAQ (screenshot below). Using our link supports SoFinance; you can also register with no ref or with someone else's.

![xPoints referral FAQ — 20% of referrals' points / 20% boost](/blog/xstocks-xpoints/03b_xpoints_referral_faq.png)

Source: [defi.xstocks.fi/points](https://defi.xstocks.fi/points)

xPoints / xStocks products are **not available to US persons** or users in sanctioned / restricted jurisdictions. Geo restrictions apply. This is not financial advice.

## What we are not saying

- We are not promising an airdrop, token, or cash value for xPoints.
- We are not saying impermanent loss is zero.
- We are not saying fee APR is locked in.
- We are not a custodian, broker, or the xStocks issuer.

![SoFinance risks docs — IL, out of range, issuer controls](/blog/xstocks-xpoints/06_sofinance_risks.png)

Source: [sofinancelab.xyz/docs/risks](https://sofinancelab.xyz/docs/risks)

Collect trading fees in range. Accumulate xPoints under **their** rules. Keep the keys.

Tool: https://sofinancelab.xyz
Points (our referral): [https://defi.xstocks.fi/points?ref=SOFINANCE](https://defi.xstocks.fi/points?ref=SOFINANCE)
$SPCX $SPCXx $SNDK $NVDAx $TSLAx

— SoFinance (@SoFinancelab)
