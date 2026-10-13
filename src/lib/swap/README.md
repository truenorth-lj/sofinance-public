# Shared swaps

`fee.ts`, `leg.ts`, and `collection.ts` own fee policy. Callers consume the shared
plans, instructions and route ALTs in their existing atomic transactions.
`SOFINANCE_FEE_WALLET` enables collection; `SOFINANCE_FEE_BPS` defaults to **10**
(maximum 100). An unset wallet disables fees. USDC is
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

## Collection by flow

| Flow | Mechanism |
| --- | --- |
| Open / selected add, USDC deposit | Reserve 10 bps from the entire deposit once; explicit checked USDC transfer before swaps/add. Both parallel legs and sequential secondary legs use zero additional fee bps. Includes the same-mint portion. |
| Open / selected add, leg output USDC | Jupiter v1 `platformFeeBps` and operator USDC `feeAccount`; output/threshold already include the fee. |
| Open / selected add, non-USDC input/output | Reserve the input fee portion; compact direct ExactIn fee route delivers its entire USDC output directly to the operator ATA. Aggregate fees in the original deposit mint into one route; sequential secondary input fees have their own route. |
| Non-USDC open / selected packet too large | Shared `fitFeeCollections` measures the actual complete candidate with the available Beam tip. Only conversion collections can be replaced by explicit input-asset transfers; USDC upfront/platform fees are never replaced. Final builder size checks still reject packets that cannot fit. |
| Compound SPCX/SPCXx rebalance | Explicit checked input-token fee from isolated harvested yield. The measured USDC conversion envelope exceeds the packet limit; original pool route and receipt proof remain intact. |
| Exit conversion | Jupiter ExactIn output USDC platform fee on each converted withdrawal asset, without reducing its input. |

No swap means no converted-leg fee (except a USDC deposit, which pays upfront).
Integer fees floor to atomic units; zero needs no instruction. The fee route pays
USDC worth the reserved input portion, subject to its own market spread and route
slippage, rather than promising an exact USDC valuation. It uses direct routing
and maxAccounts=16 to avoid another intermediate hop/setup. Missing routes fail
preparation; they never waive a fee or send collection separately. This is a
compact candidate, not a proof of globally optimal economic routing.

Before USDC collection, `feeAccountSetup` reads the operator USDC ATA. Only a
missing ATA gets `createAssociatedTokenAccountIdempotent` with **user as payer**;
existing invalid, uninitialized or frozen accounts fail closed. Fallback token
fees similarly create their own missing recipient ATA. Native fallback requires
a rent-funded operator wallet. Nothing silently skips collection. Upstream
platform fee quotes must report the requested rate and a valid amount.

[Jupiter v1 fee documentation](https://developers.jup.ag/docs/swap/v1/add-fees-to-swap)
permits ExactIn fees in either mint of the pair. We use output USDC, avoiding
WSOL fee accounts. Requests use instructionVersion V2 for Token-2022 support.
The API is superseded by v2; this module deliberately retains composable v1
swap-instructions. No deployment environment overrides were changed.

## Offline packet measurements

Run `node_modules/.bin/tsx scripts/measure-swap-fees.ts` or
`npm test -- src/lib/swap/size.test.ts`. The snapshot checks byte accounting
against serialization wherever web3.js permits serialization. Oversized messages
can exceed its internal buffer; the structural size includes all signature slots,
short-vector lengths, instructions, ALT lookups and a **100,000-lamport Beam tip**.
Limit: **1,232 bytes**.

| Representative envelope | ATA exists | ATA missing |
| --- | ---: | ---: |
| Open, USDC upfront, two legs | 1283 | 1325 |
| Open, SOL sequential + USDC conversion | 1400 | 1474 |
| Open, single leg + USDC conversion | 1328 | 1402 |
| Open, pool-token + USDC conversion | 1258 | 1332 |
| Selected add, SOL + USDC conversion | 1283 | 1357 |
| Selected add, pool-token + USDC conversion | 1141 | 1215 |
| Compound + USDC conversion | 1390 | 1464 |
| Compound input-token fallback | 1216 | 1258 |
| Exit conversion, USDC platform fee | 480 | 621 |

Open SOL sequential with native input fallback measures **1258 bytes** with tip.
These are captured instruction shapes from the repo's open/compound fixtures,
with synthetic fee-route keys and ALTs. Selected uses an increase-liquidity
shape without the NFT signer; exit uses the conversion envelope without the
separately prepared withdrawal. Fee-route shape deliberately models an independent
compact Jupiter pool. They are offline size envelopes, not executable routes or
live quotes, and do not prove every route for a flow is infeasible. Pool-token
fee conversions remove native wrap/close and the same-mint swap, and use the same independent route envelope; actual token programs,
setup, pool accounts, and route overlap alter size. A simpler production route
may fit and open/selected will retain USDC collection when it does.

The large captured two-leg USDC open itself exceeds the limit and must retry a
smaller route or fail; it never changes to a non-USDC deposit fee. Compound's
existing-ATA fallback fits with tip. A missing compound fee ATA exceeds the limit
with tip in this fixture: existing Beam selection may omit the tip if the complete
untipped packet fits, otherwise preparation fails. Fee ATA creation is never
omitted to squeeze in a transaction. Open/selected likewise retain final packet
checks after fallback. Thus **not every fee is USDC**: non-USDC compound and
oversized non-USDC open/selected conversions are the explicit exceptions.

## Compound routing assessment (report only)

Keep the current original-pool/direct-route restriction for now. It lets the
bounded search estimate post-swap sqrt price and independently prove the original
vaults in imported receipts. This estimate is only a search heuristic: the atomic
builder already simulates harvest+swap, reads the pool's actual sqrt price and
isolated balances, clamps output to `otherAmountThreshold`, adds a liquidity
buffer, then simulates the complete fixed-liquidity transaction again.

Free routing could improve output and avoid moving the position's own pool when
that pool is untouched. In that case size liquidity against that pool's observed
price, not a sqrt price extrapolated from the external swap. If a free route touches
the original pool, simulation must account for the resulting price; routes with
multiple touches cannot use the current one-swap prediction. Actual simulated
output helps size a candidate, but is not an execution guarantee. The threshold
protects only the swap output; pool price movement before execution can still make
fixed-liquidity token maxima insufficient and trigger Raydium 6017
([`PriceSlippageCheck`](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/error.rs)). Buffers/conservative balances reduce this risk without
eliminating it and leave dust. Spending quoted output rather than threshold would
increase failure risk.

Free routing also adds route/setup/account-size variability. Jupiter v1 exposes a
custom destination but no custom source: compound retargets precisely the wallet
source ATA to a fresh isolated yield account and rejects other setup/cleanup.
Receipt/import verification currently requires the original pool vaults. Opening
routing would require updating both isolation and independent receipt proof,
measuring full packets, and testing external-pool and original-pool routes. It is
not a clearly simpler safe fee-only change, so no routing behavior was changed.

All scripts/tests here are offline. No mainnet transactions were sent. Live
unsigned simulation remains needed to establish upstream instruction compatibility;
synthetic envelopes cannot establish it.
