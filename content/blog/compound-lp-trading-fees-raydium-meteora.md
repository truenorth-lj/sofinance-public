---
title: "How to compound LP trading fees on Raydium CLMM and Meteora DLMM"
description: "Raydium CLMM and Meteora DLMM do not compound trading fees for you. Here is how compounding a concentrated liquidity position works, step by step, what it costs, and when it is worth doing."
datePublished: "2026-11-21"
dateModified: "2026-11-21"
hero:
  src: /blog/compound-lp-trading-fees-raydium-meteora/hero.png
  alt: Three-step diagram of compounding a concentrated liquidity position on Raydium or Meteora - collect trading fees, swap to the right token ratio, add back into the same range
faq:
  - question: "Does Raydium compound CLMM fees automatically?"
    answer: "No. Raydium's docs say CLMM fees accrue on the position and do not auto-compound. You collect them and add them back yourself, or use a tool that builds those steps for you."
  - question: "Does Meteora DLMM compound fees automatically?"
    answer: "No. Meteora's docs say fees and rewards do not auto-compound into liquidity; they stay claimable until you claim them."
  - question: "How do I compound fees on a concentrated liquidity position by hand?"
    answer: "Collect or claim the fees, swap part of them so the two tokens match the ratio your range needs at the current price, then add that liquidity back to the same position. These actions require wallet authorization; an interface may combine them into fewer transactions."
  - question: "Does compounding change my price range?"
    answer: "No. Compounding adds liquidity to the range you already have. Changing the range is a separate management action; it is not part of compounding. Some venue interfaces also support resizing or redistributing a position."
  - question: "Can I compound an out-of-range position?"
    answer: "An out-of-range position collects no new trading fees, so there is little to compound. Any fees it collected earlier can still be claimed, but adding liquidity to a range the price is not in does not collect fees until the price returns."
  - question: "How often should I compound?"
    answer: "Only when the fees you add back are large compared with the network fee and any swap cost. For small positions that can mean rarely. Raydium's own docs note that weekly or monthly claims are often enough for larger positions."
  - question: "What does SoFinance charge to compound?"
    answer: "SoFinance charges 0.10% only on the part of the collected fees that is swapped to match the range's token ratio. If no swap is needed, there is no SoFinance fee. You also pay the normal Solana network fee."
  - question: "Can I compound Robinhood Chain positions with SoFinance?"
    answer: "Not today. One-click compound is available for Raydium and Meteora positions on Solana. Robinhood Chain positions on Uniswap v4 can be closed at any time, which returns both pool tokens and the fees collected."
---

When a concentrated liquidity position collects trading fees, the fees do not go back to work by themselves. On both Raydium CLMM and Meteora DLMM they sit in the position, claimable, until you do something with them. "Compounding" means taking those collected fees and adding them back into the same position so they become liquidity too.

This post covers how that works on each venue, what it costs, and when it is worth doing. We checked the Raydium and Meteora docs on 21 November 2026 (UTC).

**Disclosure:** we build SoFinance, which has a one-click compound for Raydium and Meteora positions. We explain the manual route first, because the steps are the same either way.

## Fees are collected, not compounded, by default

Both venues are explicit about this.

- **Raydium CLMM:** positions collect swap fees in both pool tokens, and Raydium's docs say those fees "accrue on the position and do not auto-compound." Raydium's guide says that to compound manually you "collect fees, rebalance the two tokens if needed, then increase liquidity on the position."
- **Meteora DLMM:** "Fees and rewards do not auto-compound into liquidity; they remain claimable until you claim them."

So whatever fee APR a pool shows, your position only grows from fees if you add them back. Fee APR figures, including ours, are simple estimates over a stated window; they do not assume compounding.

## How compounding works, step by step

### 1. Collect the fees

On Raydium, open the position from the portfolio page and use "Collect fees." Under the hood this is a decrease-liquidity call with zero liquidity, which sends owed fees to your wallet without touching the position's size. On Meteora, claim the position's pending fees.

You now have small amounts of both pool tokens in your wallet. In a same-stock pool such as TSLA/TSLAx, that means some TSLA and some TSLAx.

### 2. Match the ratio your range needs

A concentrated range needs the two tokens in a specific ratio that depends on where the current price sits inside the range. For a roughly symmetric CLMM range, the values can be close to half and half near the middle and mostly one token near an edge. For DLMM, the allocation also depends on the chosen bin distribution. The fees you collected are usually not in that exact ratio, so you swap part of one token into the other.

### 3. Add the liquidity back to the same position

Increase liquidity on the same position (Raydium) or add liquidity to the same bins (Meteora). The range does not change. The position is now a little larger, and the next fees it collects are on the larger amount.

## What compounding costs

Each step can cost something:

- **Network fees.** On Solana each transaction pays a small fee in SOL, and more if you add a priority fee during congestion.
- **Swap costs.** Step 2 pays the swap venue's fee and some price impact. For same-stock pairs the swap is between two versions of the same stock, so it is usually cheap, but not free.
- **Tool fees.** If a tool does the steps for you, check what it charges. SoFinance charges 0.10% only on the part of the collected fees that is swapped to match the ratio. If no swap is needed, there is no SoFinance fee. See [Pricing](/fees).

Because these costs are partly fixed per transaction, compounding very small amounts can cost more than it adds. Raydium's docs make the same point: wait until pending amounts are meaningful relative to the transaction fee.

## When compounding is worth it

- **The position is in range.** Liquidity added to a range the price is not in collects nothing until the price comes back. See [LP position out of range](/blog/lp-position-out-of-range).
- **The fees are large compared with the costs.** A bigger position or a busier pool collects more fees between compounds.
- **You plan to stay in the same range.** If you are about to close and reopen, compounding first just adds a transaction.

How much compounding adds over time depends on how much the position collects, which depends on volume, your range, your share of liquidity, and time in range. None of that is predictable. Fees not guaranteed.

## One-click compound in SoFinance

On Solana, SoFinance builds the three steps into one flow for Raydium CLMM and Meteora DLMM positions:

1. Open [Portfolio](/app/portfolio) and pick an in-range position with collected fees.
2. Choose Compound. The preview shows the fees being collected, any swap, the 0.10% fee on the swapped part, and the network fee.
3. Sign in your own wallet. The fees go back into the same position and the range stays where it is.

SoFinance never holds your tokens, and the position stays a standard Raydium or Meteora position that you can also manage on the venue itself. Compound is not available for Robinhood Chain positions today; those can be closed at any time, which returns both pool tokens plus the collected fees.

You can also ask an AI assistant to prepare a compound for a Raydium position through our [MCP server](/app/ai). It prepares an unsigned, simulated transaction; your wallet still signs it.

To find a pool to start with, see the [pools page](/pools), for example [SPCXx / SPCX on Raydium CLMM (1 bps)](/pools/spcx-spcxx-raydium-1bps), [MSTRx / MSTR on Raydium CLMM](/pools/mstr-mstrx) or [NVDAx / NVDA on Meteora DLMM](/pools/nvda-nvdax-meteora). Each pool page shows a 7-day estimated fee APR for a $1,000 deposit in the best range. Not a prediction. Fees not guaranteed.

## FAQ

### Does Raydium compound CLMM fees automatically?

No. Raydium's docs say CLMM fees accrue on the position and do not auto-compound. You collect them and add them back yourself, or use a tool that builds those steps for you.

### Does Meteora DLMM compound fees automatically?

No. Meteora's docs say fees and rewards do not auto-compound into liquidity; they stay claimable until you claim them.

### How do I compound fees on a concentrated liquidity position by hand?

Collect or claim the fees, swap part of them so the two tokens match the ratio your range needs at the current price, then add that liquidity back to the same position. These actions require wallet authorization; an interface may combine them into fewer transactions.

### Does compounding change my price range?

No. Compounding adds liquidity to the range you already have. Changing the range is a separate management action; it is not part of compounding. Some venue interfaces also support resizing or redistributing a position.

### Can I compound an out-of-range position?

An out-of-range position collects no new trading fees, so there is little to compound. Any fees it collected earlier can still be claimed, but adding liquidity to a range the price is not in does not collect fees until the price returns.

### How often should I compound?

Only when the fees you add back are large compared with the network fee and any swap cost. For small positions that can mean rarely. Raydium's own docs note that weekly or monthly claims are often enough for larger positions.

### What does SoFinance charge to compound?

SoFinance charges 0.10% only on the part of the collected fees that is swapped to match the range's token ratio. If no swap is needed, there is no SoFinance fee. You also pay the normal Solana network fee.

### Can I compound Robinhood Chain positions with SoFinance?

Not today. One-click compound is available for Raydium and Meteora positions on Solana. Robinhood Chain positions on Uniswap v4 can be closed at any time, which returns both pool tokens and the fees collected.

## Sources

- Raydium docs, [Add or remove liquidity](https://docs.raydium.io/user-flows/add-remove-liquidity), [CLMM instructions](https://docs.raydium.io/products/clmm/instructions) and [Estimating CLMM APR](https://docs.raydium.io/algorithms/clmm-apr)
- Meteora docs, [DLMM Dynamic Positions](https://docs.meteora.ag/core-products/dlmm/dynamic-positions)
- SoFinance, [Pricing](/fees), [Fee APR](/docs/fee-apr) and [Risks](/docs/risks)

---

*Docs checked on 21 November 2026 (UTC). Liquidity providing can lose money. Not financial advice. Fees not guaranteed.*
