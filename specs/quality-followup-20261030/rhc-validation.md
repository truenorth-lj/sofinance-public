# RHC open recovery

Base: `69fdef1d29bf37e0cc5a15a0cb3ec3463a0b5b37`.

## Acceptance and implementation

- Before an approval or open wallet send request, persist and read back a
  wallet/chain-scoped intent. After its response, save its hash even if the panel
  has closed. The record blocks other pools for that wallet as well.
- Unknown transport errors, invalid hashes, timeouts and invalid storage retain
  the record and block new opens. Explicit wallet rejection/signing-disabled may
  clear only the matching unsent intent.
- Recovery reads chain and receipt only. Validate the original hash, terminal
  status and the expected minted NFT before successful execute settlement. Save
  and read back its position ID before clearing pending evidence. An approval or
  on-chain revert is terminal without an NFT. Malformed receipts remain pending.
- Rechecking never restores an old execute/signature. A settled recovery requires
  a fresh preview for further operations. The uninterrupted confirmed approval
  and explicit reverted-execute re-quote behavior stays available.
- Unmount, form edits, wallet account/network/disconnect events, changed external
  wallet/pool and signing-flag changes revoke in-flight ownership. Recheck current
  account and expiry after asynchronous chain/account reads, before wallet send.
- Committed command identity rejects callbacks retained from an old render;
  synchronous revocation prevents reuse before React commits. Per-command
  ownership prevents simultaneous double clicks.
  Prepare/finalize HTTP and recovery provider reads have bounded waits.

## Limits

The EIP-1193 wallet sends the transaction itself: the application cannot derive its
hash before the response. If no hash returns, the durable intent stays blocked for
manual investigation of wallet activity. There is no automatic expiry, resend or
"clear history" bypass. This is intentionally different from Solana's locally
available signed signature.

Browser storage is local to a browser profile; snapshot comparison is not an
atomic cross-tab lock. Deleting browser storage or using another device is outside
this admission boundary. A hash cannot be durably saved when storage itself fails;
the prior unknown intent remains, and a mounted panel retains a returned hash.

This batch covers the RHC open/approval panel. The shared wallet error wording also
improves close-flow errors; the separate positions/close controller is otherwise
unchanged. No protocol flags, transaction amounts, contracts or fees changed.

## Evidence and delivery

The four original negative controls (unmount during chain read, misleading unsent
message, remount losing pending hash, repeated unknown send) failed against the
review baseline and now pass. Additional tests exercise explicit rejection,
storage failures, stale snapshots, invalid receipts, wallet events/account reads,
delayed Permit2 signatures, late hashes, read-only recovery, confirmed approval,
reverted execution and position-ID persistence failure.

Original evidence remains in `output/sofinance-latest-quality-review-20261030/`.
New logs are in `output/sofinance-rhc-open-recovery-20261030/`. Two first-run
storage-failure probes missed Happy DOM's bound instance methods. After fixing
that injection, the storage suite exposed a proxy spy leaking between tests;
both suites now use fresh isolated storage fixtures per test. The position-save
fault test passed alone and failed after the previous spies, confirming fixture
contamination. All failure logs are retained; no production behavior was weakened.

A self-review probe also reproduced a real retained-callback defect: invoking an
old Execute callback after confirmation caused a second wallet send. The first
failure is retained in `retained-callback-first.log`. Committed command identities
and synchronous revocation now reject that callback; the control passes.

- STATIC: final app/engine typecheck and ESLint on all changed source/test files
  passed. Full repository lint also passed before the final ownership refinement.
- BEHAVIORAL: final full app suite passed 5,416 tests, skipped 27 across four files.
  The two focused recovery/lifecycle files cover 56 passing tests.
- Database integration was skipped locally without a test database; hosted CI
  supplies PostgreSQL and the build/browser/container checks.

One local self-review covered the full panel, persistence/reconciliation helpers,
wallet request guard, receipt helpers, position-ID storage and dialog caller.
The OpenCode/MiniMax provider remains unavailable; no independent review claimed.

FINANCIAL NOT_EXERCISED: synthetic provider/server responses only. Hosted CI,
merge and production deployment for this batch are pending.
