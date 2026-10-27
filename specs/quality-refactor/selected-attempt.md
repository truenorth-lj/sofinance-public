# Selected history and reconciliation extraction (P2b)

Accepted runtime: `6de6e303c127a1c94542fb468a78eff5fccd648e`, tree `fe962809e453f6fb05714946ebfa29b794de1de5`. Includes delivered D1, P2a and C1. Local preservation refactor only; independent Code/Security/QA review and delivery remain root-owned gates. P2c submission extraction is deferred.

## Ownership and ordering

`transactions/selected/use-selected-attempt.ts` owns current attempt/status, raw history projection, verification error, obsolete warning, loaded-wallet fencing, signature/request ownership, legacy lookups and status polling. No new storage schema, reducer, generic transaction controller or pure model is needed. Existing storage helpers remain byte-identical.

Two cooperating hooks retain the existing effect order. `useSelectedAttempt` registers layout restoration immediately after the facade's lifetime layout effect. Stable `getLifetime`, `isWalletCurrent` and `isSubmitting` ports read the original facade identities without exporting mutable refs. `useSelectedAttemptEffects` registers load/poll after wallet/selection resets, discovery/state reads and the shared clock, before preview. Moving all effects into either call would change that order. Retry callbacks keep render-current wallet/attempt/busy values; stable setup/reconcile callbacks retain the original effect dependencies' behavior.

The facade keeps wallet/form/discovery/state, one clock, relay cache, preview wiring, input revisions, readiness, submission lock/stages and the entire prepare/sign/persist/send command. The only submission substitutions are synchronous `beginSubmission`, `publishPersisted` and guarded `restoreSignature`. Persistence still archives raw previous bytes, writes and reads back current, then history enumeration must succeed before publishing the original derived signature and sending. An enumeration failure at that point can leave a newly persisted record while the displayed attempt is still old: this accepted behavior is characterized and intentionally retained.

Pending/manual/invalid/unavailable/legacy history is a warning, never a global lock. New quote/prepare stays available. Wallet load uses its original zero-delay timer; legacy lookup is independent of preview readiness, sequential and uses the original eight-second timeout/body. Poll starts at zero and repeats every four seconds with eight-second status request timeout. Busy suppresses polling; terminal/manual-review stops it, explicit retry remains available. `checking` belongs to one effect instance; manual/direct requests can overlap and the last issued request owns results. This is not global single-flight or cross-tab mutual exclusion.

Wallet/signature/request/lifetime fences, status/signature validation, history notification timing, unknown-send retention and original error priorities are preserved. Preparation/sign failure restores prior signature ownership. Activity hidden settlement releases busy; layout-only Suspense reconnect restores the current attempt without passive storage reload or resurrecting an old submit continuation. The public return object and preview implementation are unchanged.

## Preservation evidence

Tests-first commit `68a7bd6987cca0ec3ee3c85a6c00b35062264935` precedes runtime extraction `14e50e6`. The real facade test suite now records deterministic request payload/time/order, every committed public data projection, storage method operations/bytes, signature and history notifications. Real SelectedApp caller coverage verifies that an invalid retained record warns but allows Add and survives prepare failure. Wallet/HTTP and framework routing are boundaries; storage, relay, caller and controllers remain real.

135 cases have equal raw per-case ledgers on accepted source, extracted source and exact accepted Git-blob loader overlay. Cross-file execution order is not compared; events inside each ledger are compared without normalization. No runtime checkout files are replaced during overlay or mutation. The baseline remains frozen; no blanket golden update. Existing retained-state D1 and repeated-input C1 tests run with these suites.

Seven loader mutations produce behavioral assertion failures with passing healthy controls: request ownership, lifetime ownership, 3999ms polling, omitted history enumeration, 7999ms legacy timeout, warning-as-lock, and disabled signature restoration. Scope also includes complete existing Selected/storage/relay/status/send recovery suites through the app and engine environment matrix.

Full reproducible commands, raw ledgers, failure receipts, source/patch/build identities, log hashes, fresh validation and cleanup are in workspace `output/sofinance-selected-attempt-implementation-20261028-r1.md` and its same-name directory. This evidence is local STATIC/BEHAVIORAL only; FINANCIAL NOT_EXERCISED.

## Validation limits

Fresh committed app build and hermetic browser validation use an explicit environment allowlist and loopback-only network. Units deny IP network, use native config loader, `envDir:false`, no-cache and owned caches. The stdio matrix profile permits local Unix IPC and broader temporary writes because the real child drops TMPDIR; product and historical evidence writes stay denied. Private dotenv reads remain denied, with only tracked `.env.example` permitted for build fingerprinting. The existing audited offline font fixture is reused with byte/CSS verification.

The exact unchanged engine/API/MCP/storage/dependency/CI closure is independently compared against the accepted tree. Parent PR164 hosted PostgreSQL/container receipts are historical only; there is no fresh local PostgreSQL, container build/run or packed-consumer proof for P2b. Local database skips remain skips. The Docker image bundles the standalone RWA service, not `.next`; changed client modules are outside that service import closure. Its historical container result is not a fresh image execution. Changed client output is freshly built/tested locally and cannot inherit the parent's production identity. No real provider, database, signing, broadcast, push, PR, merge or deploy is part of this slice.
