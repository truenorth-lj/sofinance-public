---
title: "Zero performance fee, no vault, no extra contract: how SoFinance compares"
description: "A factual comparison of SoFinance with automated LP managers and agents: performance fees, other protocol fees, custody, extra smart-contract layers, voting, and auto-rebalancing."
datePublished: "2026-11-13"
dateModified: "2026-11-13"
hero:
  src: /blog/competitor-comparison/comparison-table.png
  alt: Comparison table of SoFinance, Circuit, Kamino Liquidity, HawkFi, Steer Smart Pools, Beefy CLM, and Gamma on fees, custody, and auto-rebalance
---

Automated concentrated-liquidity products usually do two things we do not: they take a performance fee on the trading fees a position collects, and they put your deposit into their own vault or program. This post compares SoFinance with six products people often use when they want someone else to manage a range: Circuit's Uniswap LP agent, Kamino Liquidity, HawkFi, Steer Smart Pools, Beefy CLM, and Gamma Automated.

We want the comparison to be fair. Some of these products auto-rebalance; we do not. One of them, Circuit, also charges no protocol fee today and does not pool deposits. The table below uses each project's own public docs, checked on 13 November 2026 (UTC). Where a number is not published, we say so. This is not a ranking, and it is not a recommendation to use or avoid anyone.

## What SoFinance is

SoFinance is a self-custodial tool for opening and managing same-stock liquidity positions — for example a wrapped token and its unwrapped pair — on Solana (Raydium CLMM and Meteora) and Robinhood Chain (Uniswap v4). You connect your own wallet, review a preview, and sign. The position is a standard position NFT in that wallet. If this site went offline, a Raydium position could still be managed through Raydium. We never take custody of your keys or your tokens, and we do not operate a fund or a pooled vault.

We do not deploy a SoFinance on-chain program. The transactions you sign call the underlying venues — Raydium, Meteora, Uniswap v4 — and, when a swap is needed, a router such as Jupiter. There is no SoFinance token, no gauge, and no vote.

We also do not auto-rebalance. If price leaves your range, that position collects no trading fees until price comes back or you close or reopen it. That is a real cost of this model, and it is the main thing an automated manager is designed to take off your hands.

## How we suggest a range (this is not an AI that manages the position)

On Solana, the app scores four fixed presets around the current price — Micro, Tight (±0.05%), Standard (±0.3%), and Wide (±1%) — using the last seven days of trading volume and how liquidity sits near each price today. It highlights the preset with the highest estimated fee APR for the amount you enter; ties go to the wider range. You can pick another preset or type a custom band. The estimate assumes recent volume and prices behave like the recent past, counts fees only while price is inside the range, and ignores impermanent loss and your trading costs. It is not a prediction. Fees not guaranteed.

That is a suggestion from recent fee data, not a model that invents a custom range or moves the position later. Separately, an AI assistant can use our MCP server to list Solana same-stock pools and prepare an unsigned, simulated transaction. Your wallet still has to sign it. Robinhood Chain pools are not available through that server, and nothing is signed on your behalf.

## Fees: zero performance fee, but not zero fees

We do not take a performance fee on compounding or on the trading fees you collect. We do charge a protocol fee of 10 basis points (0.10%), and only when a swap is made for you.

- Opening or adding on Solana: 10 bps of the part of your deposit that is swapped, in the token you deposit. The part deposited directly, with no swap, is not charged.
- Compounding a Raydium position: 10 bps of the harvested tokens that are swapped to rebalance. If no swap is needed, there is no fee. One-click compound is a Raydium flow; it is not offered for Meteora or Robinhood Chain positions today.
- Withdrawing to USDC or another single token on Solana: 10 bps of the tokens that are converted.
- Withdrawing as the two original pool tokens: 0.
- Opening on Robinhood Chain: 10 bps of the tokens the swap returns, when part of your deposit is swapped. If there is no swap, there is no fee.
- Closing on Robinhood Chain: 0. You receive the two pool tokens.

The preview shows the protocol fee before you sign. You also pay network fees (SOL or ETH) and the usual venue swap costs. We may change the protocol fee; any change would be announced in advance and shown in the preview. Details: [Fees](https://sofinancelab.xyz/docs/fees) and [Terms](https://sofinancelab.xyz/terms).

## Comparison table

Figures below are from each project's public documentation, checked on 13 November 2026 (UTC). "Not stated" means we could not find a single published rate. Third-party gas, pool trading fees, and slippage apply on every venue and are not repeated in every cell.

| | Performance fee | Other protocol fees | Where funds sit | Extra contract or signing layer | Auto-rebalance | Vote / gauges |
| --- | --- | --- | --- | --- | --- | --- |
| **SoFinance** | **0%** of the trading fees you collect | **0.10%** only when we swap for you. Exit in the two pool tokens: **0** | Your wallet. Standard position NFT. No SoFinance vault | No SoFinance program. You interact with Raydium, Meteora, or Uniswap v4 | **No.** We suggest a preset from 7-day fee data; you choose and sign | None. No SoFinance token, gauge, or vote |
| **Circuit** (Uniswap LP agent on Robinhood Chain) | **0% today.** Docs say today's terms make no commitment about future fees | Circuit charges no protocol fee today. Gas, trading, routing, and other third-party fees may apply | Positions sit in a wallet you hold in Circuit. Funds are not pooled. The signing key is kept in Circuit's hardware enclave; signatures follow a passkey-signed permit. You can export the key | Circuit's execution and signing infrastructure, not a pooled LP vault | **Yes.** Every 15 minutes it ranks stock-token pools by USDG rewards per dollar, holds the top four (or a pool you pick), and recenters after price leaves the range | Not required to run the agent. Not stated as a gauge-vote product |
| **Kamino Liquidity** | Yes, on profit from auto-compounded fees and rewards. **Rate varies by vault** (no single official percentage) | Deposit and withdrawal fees may apply and also vary by vault | Deposits go into a Kamino liquidity vault (pooled) | Yes. Kamino vault programs | **Yes.** Vaults manage and rebalance the underlying DEX position | Not required to deposit. Kamino has a token and governance. Vault managers can change fee rates |
| **HawkFi** | **8%** of “yield only,” not of the initial deposit (HawkFi’s FAQ wording) | **0%** deposit, withdrawal, and automation fees | Positions are handled through HawkFi's program. The product wallet is a program-derived address and, per HawkFi's FAQ, cannot be exported | Yes. HawkFi smart contract / PDA wallet | **Yes**, based on target prices or conditions you set | Not required to open a position. HawkFi runs a points program; that is separate from a gauge vote |
| **Steer Smart Pools** | **15%** of fees collected, split among strategist, Steer Protocol, and Steer nodes | No upfront or management fee | Deposits go into Steer smart-pool contracts. Steer describes the product as non-custodial | Yes. Steer strategy / smart-pool contracts, across many chains and DEXs | **Yes.** Automated multi-position liquidity management | Not required to deposit |
| **Beefy CLM** | Capped at **9.5%** of trading fees the product collects, split among $BIFI governance participants, treasury, creator, and harvest caller | Rare withdrawal fee up to 0.1% on vaults that do not harvest on deposit. Beefy ZAP V2: 0.05%. An imbalance swap fee may apply on single-sided deposits, capped at half the pool fee | Pooled. Depositors receive an ERC-20 share token (cow / reward cow / moo token) | Yes. Beefy's CLM contracts (audited by Zellic, Cyfrin, Certora, and Sherlock in 2024) | **Yes.** Harvests claim fees and reset the position | Not required to deposit. Part of the performance fee is paid to $BIFI holders who join Beefy's governance incentives |
| **Gamma Automated** | **14–20%** of fees the vault collects, depending on the vault. Gamma's FAQ labels this as management fees | No other Gamma fee rate is stated in that FAQ. No deposit or withdrawal caps | Pooled Gamma vault. Gamma says it does not control user funds and that users can withdraw | Yes. Gamma vault contracts | **Yes.** Gamma rebalances and compounds for you | Not required to deposit |

![Comparison table of SoFinance and six automated LP products](/blog/competitor-comparison/comparison-table.png)

## How to read the closest comparisons

**Circuit is the closest product on Robinhood Chain stock-token pools**, and it is the one place the "zero performance fee" line is not a unique claim. On 12 November 2026 (UTC), Circuit published a Uniswap LP agent that ranks stock-token pairs on Robinhood Chain every 15 minutes by USDG rewards per dollar, holds the top four, keeps each range on price, and lets you withdraw at any time. Circuit's docs say it charges no fees today, pools nothing, and keeps each agent's positions in a wallet you hold in Circuit.

The honest differences are about control, not about a fee we invented. Circuit is an agent: it can recenter a position when price leaves the range, and it can run on a wallet whose signing key sits in Circuit's hardware enclave, under permits you approve (including an auto-approve window of up to an hour). SoFinance is a tool: we suggest a range, we do not move it later, and every transaction is signed in your own wallet (for example Phantom or an equivalent). We also charge 0.10% when we swap for you, which Circuit does not charge today. Circuit's terms make no commitment about future fees; neither should this post.

**Kamino, HawkFi, Steer, Beefy, and Gamma are vault- or program-style managers.** They are built to auto-compound and auto-rebalance. In exchange, they take a stated cut of the fees the position collects — 8% at HawkFi, 15% at Steer, up to 9.5% at Beefy CLM, 14–20% of fees collected at Gamma, and a vault-specific performance fee at Kamino Liquidity — and your deposit sits in their vault or program rather than as a position NFT that only your wallet controls. That can be the right trade if you want the range moved for you. It is a different product than SoFinance.

We looked at Meteora's legacy Dynamic Vault as well. Its developer docs set a 5% performance fee on positive strategy gain, minted as vault LP tokens. That program is a single-asset vault, not a same-stock concentrated-liquidity tool, so it is not a primary row in the table. Arrakis is a well-known EVM liquidity manager, but we could not find a single current official performance-fee rate we were willing to print, so we left it out rather than guess.

## Risks we do not remove

Self-custodial does not mean risk-free. Using SoFinance, you still take:

- **Pool and range risk.** A concentrated position only collects trading fees while the pool price is inside your range. Out of range, it collects nothing and is held as one of the two tokens until you act. We will not move the range for you.
- **Impermanent loss.** Relative prices can move, and the position can be worth less than simply holding the two tokens, even after fees.
- **Underlying protocol risk.** Raydium, Meteora, Uniswap v4 (including hooks), Jupiter, token programs, and the relevant network can have bugs, pause, upgrade, or fail. We add no extra SoFinance contract on top of those, but we also do not remove their risk.
- **Token and issuer risk.** Tokenized stocks depend on their issuer and custodians. They may not track the underlying share, may be frozen or restricted, and may trade while the underlying market is closed.
- **Our software and fee risk.** Our interface can have bugs. The 0.10% protocol fee, when a swap is made, is a real cost. Network fees and venue swap costs apply as well.

Estimated fee APR figures in the app are from recent data (24 hours at the pool level; 7 days for Solana range suggestions). Fees not guaranteed. See [Risks](https://sofinancelab.xyz/docs/risks) and [Fee APR](https://sofinancelab.xyz/docs/fee-apr).

## What this post is not

It is not a promise that a self-custodial, no-rebalance position will collect more trading fees than a managed vault. Automation has a cost, and it also has a job. It is not a claim that Circuit, or anyone else, is unsafe. It is not a partnership with any venue or manager named above. And it is not tax, legal, or investment advice. Read each project's docs, and read a transaction preview before you sign.

If you want the position in your wallet, a range you choose, and no cut of the trading fees you collect, that is the product we built. The suggested range is a starting point from seven days of fee data. The signature is yours.

## Sources

- SoFinance: [Fees](https://sofinancelab.xyz/docs/fees), [Security](https://sofinancelab.xyz/docs/security), [Risks](https://sofinancelab.xyz/docs/risks), [Fee APR](https://sofinancelab.xyz/docs/fee-apr), [Terms](https://sofinancelab.xyz/terms)
- Circuit: [Support / pricing](https://docs.circuit.org/support), [Agentic investing](https://circuit.org/articles/agentic-investing), [SPY Spoke LP agent](https://app.circuit.org/agents/88e94280-2cf7-406e-b8f5-347718d90a5f), [announcement post, 12 November 2026 (UTC)](https://x.com/CircuitAI/status/2120960338787176663)
- Kamino Liquidity: [Fees](https://docs.kamino.com/liquidity/fees)
- HawkFi: [FAQs](https://hawkfi.gitbook.io/whitepaper/guides-and-support/faqs)
- Steer: [Smart Pools](https://docs.steer.finance/flagship-apps/smart-pools/)
- Beefy CLM: [CLM](https://docs.beefy.finance/beefy-products/clm), [Fees breakdown](https://docs.beefy.finance/ecosystem/beefy-bulletins/beefy-finance-fees-breakdown)
- Gamma: [Using Gamma](https://docs.gamma.xyz/gamma/lp-vaults/faq/using_gamma)
- Meteora Dynamic Vault (mentioned only): [Developer guide](https://docs.meteora.ag/developer-guides/dynamic-vault), [Formulas](https://docs.meteora.ag/legacy-products/dynamic-vault/formulas)
