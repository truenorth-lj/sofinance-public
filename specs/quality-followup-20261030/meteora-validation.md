# Meteora recovery verification

Base: `09a577c905b4116a217b897bdbe395ae7427003c` (Compound PR #245).

## Scope and acceptance

The setup, deposit and close flows derive the signature from the validated,
wallet-returned message and persist its signature and last-valid block height
before the send request starts. Setup signs with an owned temporary position
secret after the wallet, then disposes that owned buffer. No secret is stored.
The existing server permit, signature, simulation and fee checks remain intact.

- Lost HTTP, invalid JSON, mismatched response signatures and polling timeout
  retain the original signature. Reload and explicit recheck query it without
  signing or broadcasting again. Unknown outcomes display as not yet verified.
- Only an explicit non-success `sent: false` response or the existing server's
  matching chain-failed/expired status permits rollback. Deposit and close
  rollback retain the confirmed setup; setup rollback removes only its record.
- Storage write/readback/removal failure stops progression. Wallet-scoped keys
  prevent one wallet from replacing another's unfinished position. Matching
  legacy records migrate only after verified scoped persistence; malformed or
  conflicting records stay blocked. Incomplete old submissions stay available
  for manual investigation, with no discard or guessed expiry.
- Committed wallet, connection, pool, signing flag and form ownership fence
  delayed preparation/signing/status callbacks. Stale operations cannot release
  a newer operation's lock, alter a newer record or publish another wallet's UI.
  Confirmed positions can be prepared/signed only in their original pool.
- A confirmed setup may prepare the existing deposit simulation automatically;
  it never signs or sends it automatically. Deposit confirmation keeps original
  signatures until optional position logging settles, then removes its record.

## Validation

Earlier review probes retained in workspace
`output/sofinance-latest-quality-review-20261030/` reproduced lost response,
missing pre-send signature, wallet-change and storage-failure defects. The first
local implementation run passed all five copied probes and two wallet helpers.

Extended lifecycle tests initially had four failures (`lifecycle-first.log`):
three reload assertions ran before React committed and scheduled the resume
effect, so the fixture now flushes that timer after commit; one exposed a real
old-wallet operation lock surviving the wallet boundary. Cleanup now revokes
that lock, while owner checks keep its eventual completion from releasing a new
operation. All sixteen then passed in `lifecycle-fixed.log`.

Further coverage includes every transaction stage's invalid-response reload,
explicit-unsent rollback, terminal failure/expiry, polling timeout then healthy
requery, mismatched status signatures, silent storage drops, delayed prepare and
send, another pool, mutated wallet messages, retained callbacks, newer records,
legacy migration/conflict/corruption and incomplete legacy signatures.

- STATIC: full lint and app/engine typecheck passed. The first lint run flagged
  an unnecessary ref increment in effect cleanup; generation identity already
  revokes that work, so it was removed. `git diff --check` passed.
- BEHAVIORAL: 43 targeted tests passed (24 panel, 17 storage, 2 wallet helpers).
  Full app suite: 5,473 passed, 27 skipped across four DB-dependent files.
  The engine has no changed source; its 702 passing tests are reused evidence
  from batch #245, not a fresh engine behavior run in this batch.
- FINANCIAL NOT_EXERCISED: no real wallet, chain send or funds movement. Existing
  production feature/signing gates remain unchanged. Hosted CI provides database,
  environment-matrix, build, hermetic browser and container checks.

Local logs: workspace `output/sofinance-meteora-open-recovery-20261030/`.

## Review and limits

Local self-review checked the complete panel/storage changes against the actual
prepare, send and status routes, server permits and wallet-returned guard. The
requested OpenCode/MiniMax review provider remains unavailable; this is not an
independent review approval. No IDE inspection tool was exposed in this session.

Storage comparison/readback is not a cross-tab atomic lock. A crash between
scoped persistence and legacy removal can leave conflicting records blocked for
investigation. Existing confirmation and block-height expiry semantics are
unchanged. Owned-buffer disposal does not claim erasure of JS/crypto copies.

Hosted CI, merge and production deployment are pending.
