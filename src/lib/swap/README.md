# Shared swap implementation

`jupiter.ts` owns Jupiter quote/build request validation; `instructions.ts` converts
and orders route instructions; `fee.ts` owns the single fee configuration, input
fee arithmetic, native/token transfers, recipient ATA creation and rent checks.
Existing `jupiter-route.ts` and `swap-fee.ts` entry points re-export the implementation
so existing imports and provider mocks continue to work. Atomic flows still own
Raydium instructions, simulation, lookup tables, Beam tips and packet limits.

## Fee audit before this refactor

| Flow | Protocol bps | Collection | Fee asset |
| --- | --- | --- | --- |
| Open position | configured rate; default 10, 0 without wallet | explicit SOL or checked SPL transfer; `/swap/v2/build` receives net input, no platform fee | original deposit input |
| Compound | configured rate on gross rebalance input; default 10, 0 without wallet | checked SPL transfer from isolated harvested input account before Raydium in-pool swap | rebalance input pool token |
| Selected position add | 0 regardless of fee environment | no protocol collection; Jupiter receives full input | none |
| Pool creation | no implementation found | none | none |

Open parallel swaps charge each converted leg, flooring separately. A same-mint
leg has no fee. Sequential open charges only the primary deposit-input conversion;
the secondary pool-token conversion has no fee. Probes may quote net fee amounts
but never execute transfers; resale estimates have no fee. Compound without a
rebalance has no collected fee. Pool trade fees and Beam tips are separate charges.

`SOFINANCE_FEE_WALLET` enables collection. `SOFINANCE_FEE_BPS` is the sole rate
override (integer, capped at 100). `DEFAULT_SWAP_FEE_BPS` in `fee.ts` is 10;
changing that one line to 20 raises the default for fee-enabled flows. There is
no hardcoded 20-bps production fee; a ledger regression test sets 20 as a historical
receipt scenario. Deployed environment values were not accessible during this
audit, so 10 is the verified repository default, not a verified deployment override.

## Jupiter platform fee assessment

Current Jupiter [build documentation](https://developers.jup.ag/docs/swap/build)
supports `platformFeeBps` plus `feeAccount` (ordinary SPL accounts, no referral
requirement). The old referral-only comment was incorrect and has been removed.
Platform collection is technically possible for token inputs but this phase retains
manual collection to preserve transaction bytes, exact input deduction and receipt
verification. Native collection would credit WSOL instead of native SOL, require
recipient token-account funding and change wrapping and rent accounting. Compound
executes a Raydium swap and cannot use Jupiter's collection mechanism. The selected
flow must retain its existing zero rate. No fee mechanism differences are introduced.

Recipient token ATAs are still created idempotently in the atomic transaction;
missing-ATA rent is checked against the simulated SOL debit cap. Native recipients
must already satisfy account rent. Floored-zero fees create no ATA or transfer.
The existing 1,232-byte checks and Beam tip fallback remain in their original flows.

## Verification and manual test

Wire snapshots captured before extraction cover the actual open/selected builders
and compact compound fixture; additional swap-envelope snapshots cover native,
SPL, Token-2022, selected zero rate and floored-zero fees. These are deterministic
mock/fixture checks, not proof of live Jupiter route execution.

Before production use, sign small mainnet open and compound transactions with
fees enabled, verify recipient balance deltas and fee rounding, repeat with absent
and existing recipient ATAs, and verify selected add has zero protocol fee. Include
native SOL and Token-2022 input, sequential open, and a compact route that omits a
Beam tip near the packet limit. This work does not implement withdrawal.
