---
title: "How to collect xStocks xPoints with SoFinance: step-by-step"
description: "A screen-by-screen walkthrough: register for xPoints, open a same-stock LP with SoFinance (it builds the Raydium position for you), then check your points."
datePublished: "2026-10-27"
dateModified: "2026-10-30"
hero:
  src: /blog/xstocks-xpoints/hero.png
  alt: xPoints activity tiers — Hold, Lend, Provide liquidity
---

xStocks are tokenized equities on Solana. The issuer's **xPoints** program tracks onchain activity with those tokens. On the points dashboard, **providing liquidity** is the highest tier — above hold and lend.

SoFinance is a self-custodial tool that opens a same-stock LP for you: you pick the pair and amount, sign once, and **SoFinance builds the Raydium LP position under the hood**. The position NFT lands in your wallet. You can also **collect trading fees** from swaps that hit your in-range position — separate from points.

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
- The points UI copy says earned points **“will be used to determine your share of future rewards.”**
- CoinDesk coverage the same week called it a points program **hinting at a possible ecosystem token**, while noting **no official token announcement**.
- The program is live (wallet registration, daily updates, LP as highest tier, referral boosts, anti-sybil cleanup). Partner writeups (e.g. Solflare) still stress points **have no monetary value** and **don’t guarantee** a future reward.

**Bottom line for readers:** there is a **strong chance** — and the market **widely expects** — that xPoints convert into a **future airdrop**. **Not confirmed by xStocks.** No amount, date, or token is promised.

How that ties to SoFinance: under the published ladder, **providing liquidity** is the highest activity tier. We are a self-custodial tool that opens a **same-stock** LP (Backpack stock token × matching xStock); **SoFinance builds the Raydium LP under the hood**, the position NFT lands in your wallet, and you can **collect trading fees** while in range — separate from points. Confirm eligible activity on the xPoints dashboard after you open. Risks: [/docs/risks](https://sofinancelab.xyz/docs/risks).

**Our referral (disclosed):** https://defi.xstocks.fi/points?ref=SOFINANCE

## 1. Register your wallet for xPoints

Open our referral link and click **Connect Wallet**:

[https://defi.xstocks.fi/points?ref=SOFINANCE](https://defi.xstocks.fi/points?ref=SOFINANCE)

![xPoints page — Connect Wallet](/blog/xstocks-xpoints/steps/step01_xstocks_points_connect_wallet.png)

Choose **Solana** (Phantom or Solflare):

![Choose Network — pick Solana](/blog/xstocks-xpoints/steps/step02_xstocks_connect_wallet_modal.png)

## 2. Open SoFinance

Go to [https://sofinancelab.xyz](https://sofinancelab.xyz) and click **Open app**.

![SoFinance home — Open app](/blog/xstocks-xpoints/steps/step03_sofinance_home_hero.png)

## 3. Connect your wallet

In the app, click **Connect wallet**. Tick **Terms of Service**, then **Continue to wallet**.

![App landing — Connect wallet](/blog/xstocks-xpoints/steps/step04_app_landing_positions_empty.png)

![Before you connect — tick Terms, Continue to wallet](/blog/xstocks-xpoints/steps/step05_app_before_you_connect_modal.png)

## 4. Find SPCXx/SPCX on RWA pairs

Open **RWA pairs**. Type **SPCX** in **Search token** (or scroll) to find **SPCXx/SPCX**. **Hide duplicate pools** is on by default, so you see one card for the pair: the pool with the highest estimated 7-day APR. Its fee tier (**1 bps** or **5 bps**) is on the card. To compare both pools, click **Show all pools (N hidden)**.

![RWA pairs list](/blog/xstocks-xpoints/steps/step06_rwa_pairs_header_first_cards.png)

![SPCXx/SPCX — one card per pair; Show all pools reveals the other fee tier](/blog/xstocks-xpoints/steps/step07_rwa_pairs_spcx_1bps_card.png)

## 5. Optional: Plan this pool

Click **Plan this pool** to see an estimate for your amount and days (based on historical data, not a guarantee). When ready, click **Create a position in this pool**.

![Plan — amount and days](/blog/xstocks-xpoints/steps/step10_plan_amount_input_and_chart.png)

## 6. Create position

Or click **Create position** on the pair card. Choose an input asset (**SOL**, **USDC**, or a pool token), an amount, and a range (**Best** is the suggested default — here **Micro ±0.02%**). Then continue.

![Create position — SPCXx/SPCX, Best = Micro ±0.02%, ~36% est. fee APR (not guaranteed; one pool snapshot)](/blog/xstocks-xpoints/steps/step08_create_position_modal_spcx.png)

## 7. Approve once in your wallet

Approve the transaction in your wallet. SoFinance swaps as needed and **builds the Raydium LP position for you**; the position NFT lands in your wallet.


## 8. Track it in the app

Open [/app](https://sofinancelab.xyz/app). Under **My positions** / **Performance** you can add liquidity, compound collected trading fees, or withdraw — you sign every time.

Numbers below are **this one position’s figures only** (not a promise or forecast).

![My positions + Performance — this position: 30.47 holding days, est. trading-fee APR 20.29%, fees 0.598370 SPCX](/blog/xstocks-xpoints/steps/step14_positions_performance_full.png)

![Performance detail — same position: results and exit estimate](/blog/xstocks-xpoints/steps/step14b_performance_detail.png)

## 9. Check your xPoints

Return to [https://defi.xstocks.fi/points](https://defi.xstocks.fi/points) and confirm your activity.

![Your xPoints dashboard shows points earned.](/blog/xstocks-xpoints/steps/step15_xpoints_balance.png)

---

Risks: see [sofinancelab.xyz/docs/risks](https://sofinancelab.xyz/docs/risks)
