# Shared swaps

All swaps use `client.ts` for Jupiter v1 quote/swap-instructions. `jupiter.ts`
validates executable routes and normalizes lookup tables. `compound.ts` builds
isolated yield routes; `instructions.ts` converts and orders instructions.
`fee.ts` owns the only rate config: `SOFINANCE_FEE_BPS`, default **10 bps**,
max 100. `SOFINANCE_FEE_WALLET` enables collection.

Open (single-sided, parallel, both sequential directions), selected add, compound,
and unsigned full-exit previews all charge each converted leg in its input asset.
Same-mint legs, no-rebalance compound, and floored-zero amounts have no transfer.
Quotes/probes never send anything; resale and principal valuations are read-only.
Open's `swapFees` records each fee mint; its legacy `feeAmount` remains denominated
in the original input mint, so secondary-token amounts are never added to it.

Token collection requires the operator's existing, initialized, unfrozen ATA for
that mint and token program. Missing ATA means a full-input route with zero fee;
we do not create operator accounts or charge users operator rent. Invalid ATAs
fail closed. Native collection remains a SOL transfer to a funded operator wallet.
An ATA disappearing after preparation fails the atomic transaction, without fees
being collected separately. Deployment environment overrides were not audited.

[Jupiter's v1 fee API](https://developers.jup.ag/docs/swap/v1/add-fees-to-swap)
uses `platformFeeBps` on quote and `feeAccount` on swap-instructions. It supports
plain token accounts (no referral setup), input/output fees for ExactIn, input
fees for ExactOut, and Token-2022 with `instructionVersion=V2`. Native fees become
WSOL receipts and need a WSOL fee account. We retain explicit transfers for
native receipt continuity and isolated compound debit/receipt proof. Both methods
add recipient keys; neither guarantees a packet below 1232 bytes. Complete packet
checks and Beam tip fallback remain in the atomic builders. v1 is superseded by
v2 in Jupiter's docs; monitor availability of this composable API.

Compound accepts only a direct Jupiter route through the original Raydium CLMM
pool. Jupiter v1 exposes a destination token account but no custom source token
account. We retarget its exact writable user source ATA to the freshly created
isolated account, omit only the source ATA setup, and reject other setup/cleanup.
Simulation verifies isolated balances; receipt/import proof checks the inner
Raydium swap's accounts, amounts, original pool vaults, and every yield transfer.
This is deliberately restrictive: unrelated pools, extra setup and larger routes
fail instead of accessing existing wallet assets. Search is bounded to 12 quotes
plus a final quote/build; final liquidity is sized from simulated balances.

## Intended snapshot diffs

- `open-token` and `open-token2022`: remove operator ATA creation; keep the checked
  fee transfer and opaque swap instruction bytes.
- `selected`: add the same 10-bps checked transfer; remove the previous zero-rate
  assumption.
- `compound`: remove operator ATA creation and replace the old stand-in system
  transfer with the shared Jupiter instruction envelope. This is an envelope
  snapshot; live route bytes depend on Jupiter.
- `open-native` and `floored-zero`: unchanged.
- Actual open/selected atomic builder snapshots remain unchanged with fees off.
  Historical direct-Raydium receipt fixtures remain to test backwards reading.

Manual mainnet checks before release: small SOL/SPL/Token-2022 open, selected add,
both sequential directions, compound with/without rebalance, and full-exit unsigned
simulation. Verify existing/missing operator ATAs, per-mint fee deltas, isolated
compound accounts and imported receipts, and near-limit packets with/without Beam
tip. In particular, verify live Jupiter source-account retargeting and rejection
of unsupported routes; mocks cannot establish upstream/on-chain compatibility.
