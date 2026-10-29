# Shared swaps

`fee.ts`, `leg.ts`, and `collection.ts` own fee policy. Callers consume the shared
plans, instructions and route ALTs in their existing atomic transactions.
`SOFINANCE_FEE_WALLET` enables collection; `SOFINANCE_FEE_BPS` defaults to **10**
(maximum 100). An unset wallet disables fees. USDC is
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

## Collection by flow

| Flow | Mechanism |
| --- | --- |
| Open / selected add | Reserve 10 bps from the entire deposit once (`depositFeePlan`); explicit checked transfer of the **input mint** to the fee wallet’s ATA for that mint before swaps/add. Native SOL is the exception: no upfront reserve; every SOL→token Jupiter leg carries `platformFeeBps=10` with `feeAccount` = the fee wallet’s **pre-created** wSOL ATA, so Jupiter takes 10 bps of that leg in the input mint (ExactIn). No direct SOL/wSOL transfer to the fee wallet and no fee-wallet ATA creation in the user tx. Native SOL kept unswapped (pools containing SOL) is refused (`assertNativeInputFeeCoverage`). Parallel legs and sequential secondary legs use zero additional fee bps. Includes the same-mint portion. |
| Compound SPCX/SPCXx rebalance | Same 10 bps input-token transfer from isolated harvested yield (the reinvested swap input). Not a performance fee on LP earnings. |
| Exit / withdraw to USDC | Jupiter ExactIn output USDC `platformFee` on each converted withdrawal asset, without reducing its input. |
| Withdraw conversion to a non-USDC mint | Still reserves the input fee and may append a compact ExactIn USDC hop (`collectSwapFee`); `fitFeeCollections` falls back to an input-asset transfer if that hop makes the packet too large. |
| Original-token withdraw | No protocol fee. |

Integer fees floor to atomic units; zero needs no instruction. Deposit flows never
append a second Jupiter fee-to-USDC route. Missing recipient ATAs get
`createAssociatedTokenAccountIdempotent` with **user as payer**; existing invalid,
uninitialized or frozen accounts fail closed. Native SOL deposits wrap the full
input into the user’s own wSOL ATA and pay the fee inside the Jupiter swap; if
the fee wallet’s wSOL ATA is missing, `requireSwapFeeAccount` fails with
`protocol_fee_account_missing` and nothing is built (it is never created in a
user tx). Nothing silently skips collection. Upstream
platform fee quotes (withdraw-to-USDC) must report the requested rate and a
valid amount.

[Jupiter v1 fee documentation](https://developers.jup.ag/docs/swap/v1/add-fees-to-swap)
permits ExactIn fees in either mint of the pair. Withdraw uses output USDC;
native SOL deposits use the input mint (wSOL) into the operator’s pre-created
wSOL ATA (LJ, 2026-10-29: Phantom flags a direct SOL transfer to the fee wallet).
With a parallel open (two SOL legs) the total is the sum of per-leg floors, at
most 1 lamport below floor(gross × 10 / 10,000). Requests use instructionVersion V2 for Token-2022 support.
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
| Open, SOL sequential + input-token fee | 1258 | 1300 |
| Open, single leg + input-token fee | 1250 | 1292 |
| Open, pool-token + input-token fee | 1211 | 1253 |
| Selected add, SOL + input-token fee | 1141 | 1183 |
| Selected add, pool-token + input-token fee | 1094 | 1136 |
| Compound input-token fee | 1216 | 1258 |
| Exit conversion, USDC platform fee | 480 | 621 |

These are captured instruction shapes from the repo's open/compound fixtures.
Selected uses an increase-liquidity shape without the NFT signer; exit uses the
conversion envelope without the separately prepared withdrawal. They are offline
size envelopes, not executable routes or live quotes. Actual token programs,
setup, pool accounts, and route overlap alter size. A missing compound fee ATA
exceeds the limit with tip in this fixture: existing Beam selection may omit the
tip if the complete untipped packet fits, otherwise preparation fails. Fee ATA
creation is never omitted to squeeze in a transaction.

Native SOL no longer adds any fee instruction: the fee wallet’s wSOL ATA is a
writable account on the Jupiter swap instruction (+32 B or an ALT index), and
no fee-wallet ATA create is ever included. Beam tip is already omitted when
oversize, and open retries smaller Jupiter routes. The 1.4M CU limit is kept: dropping it would leave the
transaction on the 200k default, which is not enough for Jupiter + Raydium.

Open / selected / compound **always** collect the protocol fee in the input
asset. The previous extra Jupiter USDC fee hop is gone on those flows (that is
what PR #120 was shrinking); withdraw-to-USDC still uses Jupiter `platformFee`.

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

## Live mainnet verification (2026-10-13, test wallet EweTgJ6v…)

Local `next dev` with the production env (`SOFINANCE_FEE_WALLET=CS5CWY…`, 10 bps)
using keyless Jupiter and no `SOLAMI_API_KEY`. **The Beam tip was therefore never
included**; add roughly 45–50 bytes for a tip instruction with a non-ALT tip
account. If a transaction plus tip would go over 1,232 bytes,
`chooseBeamTransaction` sends it without the tip. Sizes are real signed wire
bytes. Harness: `scripts/live-fee-test.ts`.

| Flow | Signed bytes (no tip) | Fee collected |
|---|---:|---|
| Open SPCX/SPCXx, USDC deposit (two legs) | 1153 | 1000 raw USDC, upfront transfer |
| Open SPCX/SPCXx, SOL deposit | 1190 | 4999 lamports SOL (fell back: USDC conversion did not fit) |
| Open SPCX/SPCXx, SPCX deposit (Token-2022) | 1107 | 313 raw USDC via fee-only Jupiter conversion |
| Selected add, USDC | 1052–1187 (route-dependent) | 1000 raw USDC |
| Selected add, SPCX | 975–1042 | 156 raw USDC via conversion |
| Compound (tiny yield) | 1089 | 0 (fee rounds to zero) |

Exit conversion only has a preview (`/api/lp-decision/exit-preview`, `executable:false`),
so it cannot be sent live.

Bugs fixed during live testing:
- Non-shared-accounts Jupiter routes (`useSharedAccounts:false`) mark the user's
  intermediate-hop ATA (e.g. USDC for SOL→USDC→SPCX) and the fee route's
  `userDestinationTokenAccount` as writable. The unselected-asset guard then
  rejected every SOL deposit from a wallet holding USDC. Funded intermediate
  accounts touched only by Jupiter instructions are now allowed. Simulation must
  show their post-balance is at least the pre-balance (fails closed).
- Compound's binary search probed dust amounts. Jupiter answered `No routes found`
  or `Cannot compute other amount threshold` (HTTP 400), which aborted the whole
  compound. Those probe sizes are now treated as "no swap at this size".

## Live overflow rates (2026-10-14, real prepare code, dry-run signed, no Beam tip)

~20 live `open-prepare` / `selected-prepare` builds per flow with varied amounts
on SPCX/SPCXx `DUzBLHZ5…` and MSTR/MSTRx `CxEUkLtu…` (pool `3ofY6ksv…` rejects
opens: unfunded tick arrays). The builders never emit >1,232 bytes; "over" is
whether the **USDC-fee candidate** exceeded the limit (temporary size probe).
Errors are upstream (RPC context slot, quote/pool snapshot expiry, Jupiter
timeouts), not size.

| Flow | Before (ff02bcd) built / USDC candidate over | Final bytes before | After own-pool routing | Final bytes after |
|---|---|---:|---|---:|
| Open, USDC two-swap | 19/20, **0%** over | 1136–1167 | 5/5, 0% | 1136 |
| Open, SOL deposit | 2/15, **100%** over (candidates 1268–1723) → SOL fee | 1186 | 4/11, 100% over (1331–1799) → SOL fee | 1178–1223 |
| Open, pool token | 20/20, 0% | 862–1178 | 8/8, 0% | 862–1040 |
| Selected add, USDC | 18/20, 0% | 1025–1151 | 5/5, 0% | 1025–1119 |
| Selected add, pool token | 17/20, 0% | 819–1075 | 7/8, 0% | 819–1007 |
| Compound | not measurable: test positions had no harvestable yield | – | – | – |

The offline envelopes above were pessimistic for USDC/pool-token flows. Only a
SOL deposit structurally cannot carry the extra SOL→USDC fee route (+145–600 B
over the ~1186 B base), so it keeps the explicit SOL fee. Own-pool routing
(`own-pool.ts`: `onlyDirectRoutes`, `dexes=Raydium CLMM`, `ammKey == poolId`,
falling back to normal routing otherwise) now applies to every pool-token↔pool-token
leg (open sequential secondary, pool-token deposits, selected add), shrinking
those packets and raising SOL-open success. Compound stays on the input-token fee:
without live yield its USDC envelope (offline 1390 B) is unverified.

Live sends 2026-10-14 (after changes; RPC broadcast, Beam disabled):

| Flow | Tx | Bytes | Fee | Fee wallet delta |
|---|---|---:|---|---|
| Open USDC 1.0 | 3HTsf7Yy… | 988 | 1000 raw USDC | +1000 USDC raw |
| Open SOL 0.002 | 21C6ykRS… | 1223 | 2000 lamports SOL | +2000 lamports |
| Open SPCX 0.006 | 3dEwCVMZ… | 974 | USDC conversion | +471 USDC raw |
| Selected add USDC 0.5 | 3Zpf7MMK… | 1120 | 500 raw USDC | +500 USDC raw |
| Selected add SPCX 0.003 | 5GpMHoRs… | 975 | USDC conversion | +157 USDC raw |

## Compound yield swap is native Raydium `swap_v2` (2026-10-15)

#95 moved the compound rebalance leg to a Jupiter own-pool `route`. That leg
(Jupiter program id + ~29 accounts, ~half outside the ALTs) never fit next to
harvest + add: live builds for SPCX/SPCXx `DUzBLHZ5…` measured 1,209–1,283 B
for harvest + fee + swap **before** the 61 B add (prod: "VersionedTransaction
too large: 1684 bytes (max: encoded/raw 1644/1232)"). The intermediate
simulation had no size check, so the failure surfaced as an RPC error.

Compound now builds the own-pool `swap_v2` directly (the pre-#95 builder,
`swap/compound.ts`, still validated by `validateCompoundSwapInstruction`). It
reuses the harvest/add pool, vault, mint and token-program keys and adds no
program. Live real-code builds (no Beam tip): 1,189 B with an existing fee
ATA, 1,223 B when the fee wallet's input-token ATA must be created.
`compileCompoundTransaction` drops the optional 1.4M CU limit (−40 B) only
when the packet would otherwise overflow; the runtime default (200k per
non-builtin instruction) covers a compound. Every intermediate packet is now
size-checked before simulation. Receipt/import proof already accepts direct
`swap_v2`. Pre-creating the fee wallet's SPCX/SPCXx ATAs restores ~74 B margin.
