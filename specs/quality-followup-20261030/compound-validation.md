# Compound recovery verification

Base: `d90fd0eae5aa4d464e2c749841e511361cdbab64`.

## Scope and acceptance

Reapply original local fixes `9022829b746a6c168d42e860a68f2fdd4b04ff2e` and
`606ba5cdc8cdf4636ab18714c22c2d86a6ff2f2f` onto current main, preserving the newer
compound submit-feedback path. The original worktree and its dirty batch test
remain unchanged. Integration commits are `fecb3d2` and `4a7d41e`.

- Removing a recovered receipt must read back the exact serialized result.
  Write/readback failures retain the attempt and successful chain observation,
  but revoke recovery admission synchronously until same-signature verification.
- Retained single-recovery and cleanup callbacks must not prepare/sign while that
  admission is revoked. Healthy requery prunes only matching receipts and does
  not duplicate terminal notifications.
- Batch fences recheck live `canStart()` after prepare, before and after wallet
  signing, before persistence, before each broadcast and before saving outcomes.
  This catches a revocation with no wallet/record change or React commit.
- After signatures are durable, revocation retains them for read-only status
  checks. Already started requests cannot be canceled as definitely unsent.
- Each broadcast mapper is async so a later fence rejection is collected by
  `Promise.allSettled`; it cannot abandon an earlier request's rejected promise.

## Validation

The copied original batch probes initially reproduced four failures after the
two receipt fixes were integrated: revoked admission still reached single/batch
signing after prepare, or broadcast after signing. `integrated-first.log` retains
those failures (54 passed, 4 failed). All pass after the live fence fix.

Coverage includes storage throw/drop/readback failure, source-signature and
legacy-address receipt matching, healthy controls, delayed prepare and signing
for one and two chunks, revocation immediately after durable persistence or the
first broadcast, preservation of all signatures, and no repeated signing over
unknown outcomes. Existing compound feedback tests remain in the full app suite.

- STATIC: full lint and final app/engine typecheck passed. Initial typecheck identified the older Vitest mock's
  untyped callable/constructor union in the batch tests; its explicit fetch
  function type fixes that without changing runtime behavior.
- BEHAVIORAL: full `pnpm test` passed 5,432 app tests and 702 engine tests; 27 app
  tests across four files were skipped. The final change was a type-only test fix;
  changed-file lint passed afterward.
- FINANCIAL NOT_EXERCISED: no real wallet, chain send or funds movement.
- Database integration needs its test DB and is skipped locally; hosted CI
  supplies PostgreSQL plus build/browser/container checks.

Logs: workspace `output/sofinance-compound-recovery-20261030/`. Earlier baseline
controls remain in `output/sofinance-latest-quality-review-20261030/`.

One local self-review covered receipt persistence, confirmation callbacks, batch
admission/fences, result collection and the newer submit-feedback path. The
OpenCode/MiniMax provider remains unavailable; no independent approval claimed.
Storage comparison is not a cross-tab atomic lock. This batch does not change
protocol amounts, fees, flags or chain confirmation semantics.

All six hosted checks passed on `96e300e`. PR #245 merged as
`09a577c905b4116a217b897bdbe395ae7427003c`. Its successful Vercel deployment
`3BkqeFr47d9RWXRR6FvMwiwtyjmA` matches the deployment ID in the production
`https://sofinancelab.xyz/app` HTML on 2026-10-30. This verifies served build
identity, not a financial transaction.
