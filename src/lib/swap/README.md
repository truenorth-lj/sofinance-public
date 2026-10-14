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
