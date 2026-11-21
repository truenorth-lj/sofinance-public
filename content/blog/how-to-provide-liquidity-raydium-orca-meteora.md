---
title: "How to provide liquidity on Solana: a same-stock LP guide, plus Raydium vs Orca vs Meteora"
description: "A step-by-step guide to opening a concentrated liquidity position on a same-stock pool like TSLA/TSLAx, and how Raydium CLMM, Orca Whirlpools and Meteora DLMM compare."
datePublished: "2026-11-20"
dateModified: "2026-11-20"
hero:
  src: /blog/how-to-provide-liquidity-raydium-orca-meteora/hero.png
  alt: Comparison table of Raydium CLMM, Orca Whirlpools and Meteora DLMM on fee tiers, range setting, fee claiming, rewards and same-stock pool coverage
faq:
  - question: "What is the easiest way to provide liquidity on Solana?"
    answer: "Pick a pool with real liquidity on Raydium, Orca or Meteora, connect a self-custodial wallet with some SOL for fees and rent, deposit both tokens in a price range, and sign. Start small while you see how ranges behave."
  - question: "What is the difference between Raydium CLMM, Orca Whirlpools and Meteora DLMM?"
    answer: "Raydium CLMM and Orca Whirlpools use ticks and give you a position NFT. Meteora DLMM uses price bins, lets you shape liquidity inside your range (Spot, Curve or Bid-Ask), and records your position in a program account instead of an NFT. Fee tiers, the protocol's share of fees, and rent costs also differ."
  - question: "Does Orca have xStocks or same-stock pools?"
    answer: "Yes. On 20 November 2026 (UTC), Orca had same-stock Whirlpools for at least eight stocks with more than $1,000 of liquidity, including NVDA/NVDAx, MSTR/MSTRx, HOOD/HOODx, GOOGL/GOOGLx, AMZN/AMZNx and SPCX/SPCXx. SoFinance does not support Orca yet, so you would use Orca's own app for these pools."
  - question: "Do I need both tokens to open a position?"
    answer: "Usually yes, for a range that contains the current price. If the price sits near one edge of your range, you need mostly one token. A range entirely above or below the current price takes only one token, but collects no fees until the price enters it."
  - question: "How much SOL do I need to open a position?"
    answer: "Enough for network fees plus rent. Orca lists about 0.0088 SOL of refundable position rent; Meteora DLMM lists about 0.059 SOL, also refundable. Either can add a non-refundable charge if your range opens a new tick or bin array. Raydium shows its rent in the UI before you sign."
  - question: "Are trading fees compounded automatically?"
    answer: "Not on Raydium, Orca or Meteora by default. Fees build up in the position until you collect, harvest or claim them, or close the position."
  - question: "What happens when the price goes out of my range?"
    answer: "The position stops collecting trading fees and holds only one of the two tokens. It starts collecting again if the price comes back into range. Otherwise you can close it and open a new range."
  - question: "Can same-stock pools lose money?"
    answer: "Yes. The two tokens can drift apart in price, the issuers can freeze or restrict tokens, and costs can exceed the fees you collect. Fees not guaranteed."

---

A liquidity position lets you collect trading fees from swaps that pass through a pool. On Solana, the three big concentrated-liquidity venues are Raydium CLMM, Orca Whirlpools and Meteora DLMM. All three now list "same-stock" pools: two tokens that track the same share, such as TSLA (issued by Backpack Securities) and TSLAx (an xStock), or ANT and ANTx for Anthropic.

This guide does two things. First, it walks through opening a position step by step, with the details that matter for same-stock pools. Second, it compares the three venues side by side, using each project's own docs and live pool data. We checked everything on 20 November 2026 (UTC). Where a venue does not publish a number, we say so.

**Disclosure:** we build SoFinance, a tool that opens same-stock positions on Raydium and Meteora (and Uniswap v4 on Robinhood Chain). SoFinance does not support Orca today. We have tried to keep this comparison fair, and nothing here is a recommendation to use or avoid any venue.

## What a same-stock pool is, in one paragraph

A same-stock pool pairs two tokens that give exposure to the same company. Because both sides should trade near the same price, the pool price usually stays close to 1.00, and swaps between them come from traders and routers moving between the two issuers' tokens. That is why these pools often use the lowest fee tiers (0.01% to 0.05%) and very narrow ranges. Narrow is not the same as safe: the two tokens are issued by different companies, under different terms, and the price between them can still move. More on that in the risks section below. For a longer intro, see [What is a same-stock LP pool?](/learn/what-is-a-same-stock-lp-pool).

## How concentrated liquidity works (the short version)

In a classic AMM pool, your deposit is spread across every possible price. In a concentrated-liquidity pool you pick a **price range**. Your deposit only does work, and only collects trading fees, while the pool price is inside that range.

- **Raydium CLMM** and **Orca Whirlpools** split prices into *ticks*. Each tick is a 0.01% price step, and your range edges must sit on multiples of the pool's tick spacing. Each position is an NFT in your wallet.
- **Meteora DLMM** splits prices into *bins*. Each bin holds liquidity at one price, and the gap between bins is the pool's *bin step* (1 basis point = 0.01% in the same-stock pools we looked at). Each position is a program account owned by your wallet, not an NFT.

When the price leaves your range, the position holds only one of the two tokens and collects nothing until the price comes back, or until you close it and open a new range. None of the three venues moves your range for you by default.

## Step by step: how to open an LP position on a same-stock pool

The steps are almost the same on all three venues. Differences are noted inline.

### 1. Check that you can hold the tokens

Tokenized stocks are not available everywhere. Before you buy or deposit, read the issuer's terms and check that they serve your country. Both xStocks and Backpack Securities tokens on Solana have a freeze authority set on the mint (you can see it on any Solana explorer), which means the issuer can freeze token accounts.

### 2. Set up a Solana wallet and some SOL

Use a self-custodial wallet such as Phantom, Solflare or Backpack. Keep SOL for network fees **and** for rent. Rent is a refundable deposit Solana charges to create accounts:

- **Orca:** about 0.0088 SOL per position, refunded when you close it. If your range touches a tick array nobody has used yet, about 0.07 SOL more, not refunded (Orca calls this uncommon).
- **Meteora DLMM:** about 0.059 SOL per position, refunded on close, plus refundable extension rent for ranges wider than 69 bins. If your range reaches bins nobody has used, about 0.075 SOL per new bin array, not refunded.
- **Raydium CLMM:** position accounts are refunded when you close. The first position to touch a tick array pays its rent, which is never refunded. Raydium's docs do not publish a fixed SOL figure; the UI shows it before you sign.

### 3. Get the tokens you will deposit

For an in-range position you normally need both tokens, for example TSLA and TSLAx. If the current price sits near one edge of your range, you need mostly one of them. You can swap on the venue itself or through an aggregator such as Jupiter. On thin same-stock pools, check the price impact before you swap.

### 4. Find the right pool, and check the mints

Search by ticker, then **confirm both mint addresses** match the issuer's official token. Many same-stock pairs have several pools with different fee tiers, and some hold almost nothing. On 20 November 2026 (UTC) Orca listed six SPCX/SPCXx pools, and four of them held less than $1 of liquidity. Pick a pool with real liquidity and recent volume.

### 5. Choose a fee tier

Same-stock pools mostly sit in the 0.01%–0.05% tiers. A lower fee usually attracts more volume, because routers prefer cheap pools; a higher fee collects more per swap but may see fewer swaps. Two venues add dynamic fees on top of the base rate:

- **Orca** "Adaptive Fee" pools raise the fee when price moves quickly.
- **Meteora DLMM** adds a variable fee when swaps cross many bins in a short time.
- **Raydium CLMM** pools can also be created with a dynamic fee on top of the fee tier.

### 6. Set your range

- **Raydium:** enter a lower and upper price. The UI warns you if the position will be out of range or single-sided.
- **Orca:** choose *Custom* in the Liquidity Terminal, then drag the range on the chart, pick a ±% preset, or type prices. Orca also offers *Full range*.
- **Meteora:** set Min and Max price (the default is 69 bins around the current price, up to 1,400 bins per position), then choose a liquidity shape: **Spot** (even), **Curve** (more liquidity near the middle) or **Bid-Ask** (more near the edges).

For a same-stock pool, a range of a few tenths of a percent around 1.00 is common. A tighter range collects more per dollar while price stays inside it, and goes out of range sooner. A wider range lasts longer and collects less per dollar.

### 7. Review costs and sign

Before you approve, check: the token amounts, the range, the network fee, the refundable and non-refundable rent, and slippage. Then approve in your wallet.

### 8. Collect fees and manage the position

Fees are not added to your position automatically on any of the three venues. You collect them yourself:

- **Raydium:** fees and rewards are paid out when you decrease liquidity or close the position (a zero-size decrease collects fees only).
- **Orca:** use *Harvest* on one position or *Harvest All* on the Portfolio page.
- **Meteora:** claim fees from the position panel. *Withdraw and Close* removes everything and returns the position rent.

If price leaves your range, your options are to wait, or to close and open a new range. Each new range means new transaction fees and possibly new rent.

## Raydium vs Orca vs Meteora: side by side

Sources for every row are listed under the table. "LP share" is the part of each swap fee that goes to liquidity providers after the protocol's cut.

| | **Raydium CLMM** | **Orca Whirlpools** | **Meteora DLMM** |
|---|---|---|---|
| Liquidity model | Concentrated liquidity, ticks (Uniswap v3 style) | Concentrated liquidity, ticks (Uniswap v3 style); also full-range "Splash" pools | Discrete price bins; one active bin at a time |
| Fee tiers | Live configs from 0.01% to 4% (tick spacing 1 for tiers up to 0.05%) | 0.01%, 0.02%, 0.04%, 0.05%, 0.16%, 0.30%, 0.65%, 1%, 2% | Base fee set per pool with the bin step; same-stock pools we found use bin step 1 and a 0.01% base fee |
| Dynamic fee | Optional per pool | Optional "Adaptive Fee" pools | Variable fee on top of base fee, when configured |
| LP share of each swap fee | 84% (12% protocol, 4% fund) on current configs | 87% (12% Orca DAO treasury, 1% Climate Fund) | 90% on standard pools (10% protocol); 80% on launch pools |
| How you set a range | Lower and upper price on ticks | Custom range (drag, ±% presets, prices) or full range | Min/max price in bins (69 by default, up to 1,400) plus a Spot, Curve or Bid-Ask shape |
| What you hold | Position NFT (transferable; frozen only for pools on Raydium's restricted-issuer list, which xStocks and Backpack tokens are not on as of this check) | Position NFT (burning it loses the position) | Position account owned by your wallet (not an NFT) |
| Collecting fees | Paid out on decrease or close; not compounded for you | Harvest / Harvest All; not compounded for you | Claim from the position panel; not compounded for you |
| Extra rewards | Up to 3 reward streams per pool, only to in-range liquidity | Some pools have token rewards; marked in the UI | Only in "liquidity mining" mode pools (not limit-order mode pools) |
| Position rent | Position accounts refundable on close; first tick-array rent not refundable | ~0.0088 SOL, refundable; ~0.07 SOL if you open a new tick array, not refundable | ~0.059 SOL, refundable; ~0.075 SOL per new bin array, not refundable |
| Same-stock pools with ≥ $1k TVL (20 Nov 2026 UTC) | 13 pools across 11 stocks | 10 pools across 8 stocks | 4 pools (ANT, NVDA, SPCX, TSLA) |
| Supported in SoFinance | Yes | **Not yet** | Yes |

Active reward streams: at our snapshot none of the same-stock pools in the table below had an active reward stream on any venue. Raydium's largest SPCX/SPCXx pool shows a RAY stream that ended in June 2026.

Two other things worth knowing. Orca and Loopscale announced a merger into a company called Formation in October 2026; Orca's FAQ says Whirlpool positions, fees and rewards are unchanged and nobody needs to migrate or sign anything. Meteora also runs a newer tick-based product, DLMM Pro, with multi-range NFT positions; this guide covers classic DLMM, which is where the same-stock pools are today.

### Live same-stock pools: a snapshot

Largest same-stock pools on each venue with at least $20k of liquidity and at least seven days of history. Data from each venue's public API on **20 November 2026, 07:09–07:13 UTC**. "Fee APR" is the pool average: LP fees over the last 7 days (after the protocol's share) ÷ current TVL × 365 ÷ 7. For Raydium and Orca the window is the trailing 7 days to the snapshot; for Meteora it is the 7 full UTC days 13–19 November. A position with a narrow in-range band can collect more than the pool average, and an out-of-range one collects nothing. Venue pages use their own methods and may show different numbers. **Past fees, not a prediction. Fees not guaranteed.**

| Venue | Pool | Fee tier | TVL | 7d volume | 7d pool-average fee APR |
|---|---|---|---|---|---|
| Raydium | SPCX/SPCXx | 0.01% | $248,305 | $5.24M | 9.3% |
| Raydium | MSTR/MSTRx | 0.05% | $55,713 | $633k | 24.9% |
| Raydium | SPCX/SPCXx | 0.05% | $27,068 | $59.2k | 4.8% |
| Orca | NVDA/NVDAx | 0.04% base, adaptive | $154,414 | $4.38M | 55.5% |
| Orca | MSTR/MSTRx | 0.04% | $54,854 | $176k | 5.8% |
| Orca | NVDA/NVDAx | 0.02% base, adaptive | $35,605 | $988k | 27.3% |
| Meteora | TSLA/TSLAx | 0.01% base, bin step 1 | $45,805 | $746k | 7.7% |
| Meteora | NVDA/NVDAx | 0.01% base, bin step 1 | $43,857 | $4.80M | 51.7% |
| Meteora | SPCX/SPCXx | 0.01% base, bin step 1 | $29,221 | $643k | 12.9% |

New pools are left out because seven days of history do not exist yet. ANT/ANTx pools opened on Raydium and on Meteora (19 November 2026, 17:08 UTC) the day before this snapshot.

What the snapshot shows: no venue is "best" across the board. Volume for the same stock is split across venues and fee tiers, and it moves quickly. NVDA/NVDAx had its deepest pool on Orca, SPCX/SPCXx on Raydium, and TSLA/TSLAx on Meteora. Check the specific pool, not the venue.

## Which venue fits which LP?

- **Raydium CLMM** if you want the widest choice of same-stock pairs and a standard position NFT, with a simple lower/upper price range.
- **Orca Whirlpools** if the deepest pool for your stock is there (for example NVDA/NVDAx at our snapshot), and you like Orca's range tools and Harvest All. Today you would use Orca's own app for this; SoFinance does not open Orca positions.
- **Meteora DLMM** if you want to shape liquidity inside the range (Spot, Curve, Bid-Ask) or place one-sided liquidity across bins.

You can also split a deposit across venues. Each position is managed separately.

## Risks: read this before you deposit

- **Divergence (impermanent) loss.** If the price between the two tokens moves, your position ends up holding more of the token that fell in relative terms. In a very narrow range this can happen quickly, even in a same-stock pair. Our [impermanent loss guide](/learn/impermanent-loss-on-same-stock-pools) has a worked example.
- **Out of range.** When the price leaves your range, you collect no trading fees, and you hold only one of the two tokens.
- **Issuer and custody risk.** Each stock token is a claim on its issuer, under that issuer's terms, not a share held in your name. Issuers can freeze token accounts, restrict who may hold or redeem, and pause or change a token. The two sides of a same-stock pair come from different issuers, so you carry both.
- **Market hours and gaps.** The underlying stocks trade on exchange hours, while the tokens trade around the clock. Weekend news and opening gaps can move one token before the other.
- **Smart-contract risk.** You rely on the venue's program (and any app or router you use). Audits reduce this risk; they do not remove it.
- **Costs.** Network fees, swap costs, non-refundable rent and price impact on thin pools all reduce what you keep, especially on small deposits.
- **Fees not guaranteed.** Past volume does not say what future volume will be.

## FAQ

### What is the easiest way to provide liquidity on Solana?

Pick a pool with real liquidity on Raydium, Orca or Meteora, connect a self-custodial wallet with some SOL for fees and rent, deposit both tokens in a price range, and sign. Start small while you see how ranges behave.

### What is the difference between Raydium CLMM, Orca Whirlpools and Meteora DLMM?

Raydium CLMM and Orca Whirlpools use ticks and give you a position NFT. Meteora DLMM uses price bins, lets you shape liquidity inside your range (Spot, Curve or Bid-Ask), and records your position in a program account instead of an NFT. Fee tiers, the protocol's share of fees, and rent costs also differ.

### Does Orca have xStocks or same-stock pools?

Yes. On 20 November 2026 (UTC), Orca had same-stock Whirlpools for at least eight stocks with more than $1,000 of liquidity, including NVDA/NVDAx, MSTR/MSTRx, HOOD/HOODx, GOOGL/GOOGLx, AMZN/AMZNx and SPCX/SPCXx. SoFinance does not support Orca yet, so you would use Orca's own app for these pools.

### Do I need both tokens to open a position?

Usually yes, for a range that contains the current price. If the price sits near one edge of your range, you need mostly one token. A range entirely above or below the current price takes only one token, but collects no fees until the price enters it.

### How much SOL do I need to open a position?

Enough for network fees plus rent. Orca lists about 0.0088 SOL of refundable position rent; Meteora DLMM lists about 0.059 SOL, also refundable. Either can add a non-refundable charge if your range opens a new tick or bin array. Raydium shows its rent in the UI before you sign.

### Are trading fees compounded automatically?

Not on Raydium, Orca or Meteora by default. Fees build up in the position until you collect, harvest or claim them, or close the position.

### What happens when the price goes out of my range?

The position stops collecting trading fees and holds only one of the two tokens. It starts collecting again if the price comes back into range. Otherwise you can close it and open a new range.

### Can same-stock pools lose money?

Yes. The two tokens can drift apart in price, the issuers can freeze or restrict tokens, and costs can exceed the fees you collect. Fees not guaranteed.

## Where SoFinance fits

SoFinance is a self-custodial tool for same-stock positions on Raydium CLMM and Meteora DLMM on Solana, and Uniswap v4 on Robinhood Chain. You can open a position from a single token, see a suggested range based on recent fee data, and sign in your own wallet. The position stays a standard Raydium or Meteora position, so you can also manage it directly on that venue. We charge 0.10% only when we swap tokens for you; see [Pricing](/fees). We do not support Orca today. The full pool list is on the [pools page](/pools).

Related reading: [what to do when a position goes out of range](/blog/lp-position-out-of-range), [how to compound LP trading fees on Raydium and Meteora](/blog/compound-lp-trading-fees-raydium-meteora), [same-stock pool vs stock/USDC pool](/blog/same-stock-pool-vs-stock-usdc-pool), [the xStocks multiplier, explained](/blog/xstocks-multiplier-explained) and [Robinhood Chain stock LP on Uniswap v4](/blog/robinhood-chain-stock-lp-uniswap-v4).

---

*Data and docs checked on 20 November 2026 (UTC). Pool numbers change by the minute. Not financial advice. Fees not guaranteed.*