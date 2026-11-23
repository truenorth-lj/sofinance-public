---
title: "How to collect xStocks xPoints with SoFinance: step-by-step"
description: "A screen-by-screen walkthrough: register for xPoints, open a same-stock LP with SoFinance (it builds the Raydium or Meteora position for you), then check your points."
datePublished: "2026-10-27"
dateModified: "2026-11-23"
hero:
  src: /blog/xstocks-xpoints/hero.png
  alt: xPoints activity tiers — Hold, Lend, Provide liquidity
---

xStocks are tokenized equities on Solana. The issuer's **xPoints** program tracks onchain activity with those tokens. On the points dashboard, **providing liquidity** is the highest tier — above hold and lend.

SoFinance is a self-custodial tool that opens a same-stock LP for you: you pick the pool and amount, approve in your wallet, and **SoFinance builds the Raydium or Meteora LP position under the hood**. The position belongs to your wallet. You can also **collect trading fees** from swaps that hit your in-range position — separate from points.

![xPoints activity tiers — Hold, Lend, Provide liquidity](/blog/xstocks-xpoints/03_xpoints_dashboard.png)

Source: [defi.xstocks.fi/points](https://defi.xstocks.fi/points)

![xPoints are live — @xStocksFi](/blog/xstocks-xpoints/01_xstocks_xpoints_live.png)

Source: [x.com/xStocksFi/status/2033952074463916318](https://x.com/xStocksFi/status/2033952074463916318)

**Our referral link:** [https://defi.xstocks.fi/points?ref=SOFINANCE](https://defi.xstocks.fi/points?ref=SOFINANCE) (you get a 20% points boost; we get 20% of your points, per the xPoints FAQ)

## What is xStocks

- **xStocks** are tokenized U.S. stocks and ETFs: each token is designed to be **1:1 backed** by the underlying equity held with regulated custodians. They give **price exposure**, not classic shareholder voting or cash dividends (dividend economics are passed through via a rebasing / multiplier mechanism).
- **Issuer:** Backed Assets (JE) Limited (Jersey). The product line is built by **Backed Finance**; Kraken’s parent **Payward** acquired Backed Finance (deal announced Dec 2025; change of control around Jan 2026), so xStocks now sits inside the Payward / Kraken group.
- **Chains:** issued / withdrawable as onchain tokens on **Solana, Ethereum, TON, and Ink** (per Kraken’s FAQ). Once in a self-custody wallet they trade like other tokens.
- **Where people use them:** major CEX distribution from day one on **Kraken** and **Bybit**; on Solana they show up in wallets (Phantom, Solflare) and DeFi (AMMs, lending / collateral such as Kamino). Tickers end in **x** — e.g. $AAPLx, $NVDAx, $SPCXx, $SPYx.
- **Scale (public snapshots, not our claims):** Solana’s case study (as of **19 Jan 2026**) cited **>$3B** total onchain transaction volume, **>$517M** DEX volume, and **>57k** unique holders. CoinDesk (10 Mar 2026) reported xStocks saying **>$25B** combined transaction volume in the first eight months. Kraken’s FAQ (updated **18 Sep 2026**) lists **131** xStocks (100 stocks, 27 ETFs, 4 specialist).
- **Who can use them:** aimed at eligible **non-U.S.** users; not available in the U.S. (or to U.S. persons), and typically also blocked in Canada, the UK, Australia, and sanctioned jurisdictions. Always check the issuer / venue rules for your location.
- **xPoints** is xStocks’ onchain activity program (not run by SoFinance). It tracks registered-wallet activity — hold, lend, **provide liquidity** (highest published tier), quests, referrals — and updates daily. Official framing: points help determine your **share of future rewards**.

## Why xPoints matter / airdrop

In crypto, a live points program that scores real onchain usage and talks about a **“share of future rewards”** is **widely expected** to convert into a **future airdrop or ecosystem token**. That is the usual market read — and the reason LPs are farming the highest tier now.

What is on the record:

- xStocks’ own launch post (10 Mar 2026) frames xPoints as incentives so **“the community helping build it should grow with it.”**
- The points UI copy says your points **“will be used to determine your share of future rewards.”**
- CoinDesk coverage the same week called it a points program **hinting at a possible ecosystem token**, while noting **no official token announcement**.
- The program is live (wallet registration, daily updates, LP as highest tier, referral boosts, anti-sybil cleanup). Partner writeups (e.g. Solflare) still stress points **have no monetary value** and **carry no promise** of a future reward.

**Bottom line for readers:** there is a **strong chance** — and the market **widely expects** — that xPoints convert into a **future airdrop**. **Not confirmed by xStocks.** No amount, date, or token is promised.

How that ties to SoFinance: under the published ladder, **providing liquidity** is the highest activity tier. We are a self-custodial tool that opens a **same-stock** LP (Backpack stock token × matching xStock); **SoFinance builds the Raydium or Meteora LP under the hood**, the position belongs to your wallet, and you can **collect trading fees** while in range — separate from points. Confirm eligible activity on the xPoints dashboard after you open. Risks: [/docs/risks](https://sofinancelab.xyz/docs/risks).

**Our referral (disclosed):** https://defi.xstocks.fi/points?ref=SOFINANCE

## 1. Register your wallet for xPoints

Open our referral link and click **Connect Wallet**:

[https://defi.xstocks.fi/points?ref=SOFINANCE](https://defi.xstocks.fi/points?ref=SOFINANCE)

![xPoints page — Connect Wallet](/blog/xstocks-xpoints/steps/step01_xstocks_points_connect_wallet.png)

Choose **Solana** (Phantom or Solflare):

![Choose Network — pick Solana](/blog/xstocks-xpoints/steps/step02_xstocks_connect_wallet_modal.png)

## 2. Open SoFinance

Go to [https://sofinancelab.xyz](https://sofinancelab.xyz) and click **See pools** (or **Pools** in the top menu).

![SoFinance home: See pools](/blog/xstocks-xpoints/steps/step03_home_see_pools.png)

## 3. Connect your wallet

Open **Portfolio** and click **Connect wallet**. Tick **Terms of Service**, then click **Continue to wallet** and pick your Solana wallet (Phantom, Solflare, Backpack and others).

![Portfolio: Connect wallet](/blog/xstocks-xpoints/steps/step04_portfolio_connect.png)

![Before you connect: tick Terms, then Continue to wallet](/blog/xstocks-xpoints/steps/step05_before_you_connect.png)

## 4. Find SPCXx/SPCX on Pools

Open [Pools](https://sofinancelab.xyz/pools). Each card shows the pair, chain, DEX, an **Est. APR · 7d**, TVL, 24h volume and the fee tier.

![Pools: one card per pool, with Open position and Calculate. Card APRs are 7-day estimates as of 20 Nov 2026 (UTC). Not a prediction. Fees not guaranteed.](/blog/xstocks-xpoints/steps/step06_pools_list.png)

Type **SPCX** in the **Search tokens** box. When one DEX on one chain has more than one pool for the same pair, the list shows only the pool with the highest estimated 7-day APR. Click **Show duplicates (N)** to see the others. On 20 Nov 2026 the search showed two SPCXx/SPCX cards on Solana (Meteora and Raydium, both **1 bps**) plus the Robinhood Chain SPCX/SPCXon pool, and **Show duplicates (1)** revealed the Raydium **5 bps** pool.

![Search tokens: SPCX. Two SPCXx/SPCX pools on Solana and one on Robinhood Chain. APRs are 7-day estimates as of 20 Nov 2026 (UTC). Not a prediction. Fees not guaranteed.](/blog/xstocks-xpoints/steps/step07_pools_search_spcx.png)

## 5. Optional: Calculate

Click **Calculate** on a card to compare holding SPCX on its own (HODL) with holding it in the pool (HODL + more shares) for an amount and a number of days. It is a best case built from the pool's past fees, not a forecast. Fees not guaranteed. When you're ready, click **Open position** in the same dialog.

## 6. Open position

Or click **Open position** on the card. Choose an input asset (**USDC** or one of the pool tokens), an amount, and a price range. **Best** is the suggested default: the range with the highest estimated fee APR over the last 7 days (here **Micro ±0.02%**). The dialog lists the position rent, the 0.1% platform fee on the part we swap, and how many approvals your wallet will ask for.

![Open position: SPCXx/SPCX on Meteora, Best = Micro ±0.02%, ~16% est. fee APR (last 7 days, ~$1,000 deposit, as of 20 Nov 2026 UTC). Not a prediction. Fees not guaranteed.](/blog/xstocks-xpoints/steps/step08_open_position_dialog.png)

## 7. Approve in your wallet

Click **Connect wallet** (if you haven't yet), then approve each transaction in your wallet. The dialog tells you how many there are, for example 2 for this pool. SoFinance swaps as needed and **builds the Raydium or Meteora LP position for you**. The position belongs to your wallet. We don't show the wallet approval screens here: always check what you sign in your own wallet.

## 8. Track it in Portfolio

Open [Portfolio](https://sofinancelab.xyz/app/portfolio). Under **All positions** you can add liquidity, compound collected trading fees, or withdraw. You sign every time. The **Performance** view shows each position's holding days, collected trading fees and an exit estimate. Those figures are for your own position only, not a promise or forecast.

## 9. Check your xPoints

Return to [https://defi.xstocks.fi/points](https://defi.xstocks.fi/points) and confirm your activity.

![Your xPoints dashboard shows your points.](/blog/xstocks-xpoints/steps/step15_xpoints_balance.png)

---

Risks: see [sofinancelab.xyz/docs/risks](https://sofinancelab.xyz/docs/risks)
