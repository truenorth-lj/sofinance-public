# SOL recovery validation

Base: `3ab55afa411597861db60b1cf5a9bf2fa8f76f28`.
Scope: browser SOL step-1 pending record, read-only reconciliation, receipt handoff
and new-open admission. No server transaction construction or financial policy changes.

## Local evidence

- STATIC: full `pnpm lint` passed; after final review edits, ESLint passed on all
  nine changed source/test files. Final `pnpm typecheck` passed for app and engine.
- BEHAVIORAL: full `pnpm test:app` passed 5,379 tests, skipped 27 tests across four
  files. This run preceded the final ownership-check ordering and positive-height
  validation edits. After those edits, the three SOL test files passed 44 tests,
  and controller/submission characterization/ownership files passed 152 tests.
- First typecheck failed on test fetch mock typing and nullable recovery error
  state. Both were corrected; the original failure log is retained.
- The original transport-error and invalid-JSON probes failed on base and pass
  with the fix. Other cases cover pre-send storage write/readback failure,
  mismatched response signature, timeout/remount, wallet and pool changes,
  invalid stored data, explicit unsent, chain failure/expiry, changed snapshots,
  receipt handoff failure and preservation of an existing step-2 signature.
- Logs retained in workspace `output/sofinance-sol-swap-recovery-20261030/`.
  Original negative controls remain in `output/sofinance-latest-quality-review-20261030/`.

## Review

One local self-review pass covered changed files, their caller, the legacy receipt
store, and SOL broadcast/status server contracts. It tightened ownership checking
before publishing admission errors and matched positive block-height validation
to the status API. No remaining actionable finding in this scoped pass.

The workflow's OpenCode/MiniMax reviewer is unavailable because its provider is
disabled. This is a self-review, not independent approval. IDE MCP inspections
were unavailable; native ESLint and TypeScript checks were used.

## Boundaries and remaining gates

- FINANCIAL NOT_EXERCISED: no real signing, broadcasting or funds movement.
- Database integration is skipped locally without its test database; hosted CI
  supplies PostgreSQL. Hosted CI passed on `a274603` (check, database,
  e2e-hermetic and container); merged through [PR 243](https://github.com/truenorth-lj/sofinance-public/pull/243)
  as `69fdef1d29bf37e0cc5a15a0cb3ec3463a0b5b37`.
- Deployment verified on 2026-10-30: that merge SHA's Vercel status is success
  for `FQGMKRWLZ8kcEwmNtFRXjAhw6Gx9`; an HTTP GET of
  `https://sofinancelab.xyz/app` returned the same `dpl_` identity in its HTML.
  This proves deployed identity and HTTP availability, not a real wallet flow.
  Vercel CLI inspect lacked access to the account; GitHub commit status and the
  custom-domain HTML were used instead.
- Storage readback detects changed snapshots; it does not provide atomic locking
  across simultaneous browser tabs. Cross-device storage is not shared.
- Recovery never prepares, signs or resends. A successful explicit recheck saves
  a receipt; the user separately continues step 2. The uninterrupted original
  two-step command retains its existing automatic transition to step 2.
- Legacy landed receipts retain their existing TTL and wallet-switch policy.
  Unresolved pending attempts use a separate wallet key and have no clock expiry.
- The gate covers this open-position surface; other transaction surfaces are
  separate follow-up batches in the delivery checklist.
