# Selected add lifecycle safety fix

Base: `f9004515b2dfcd6ac30f093b795d510ce53f6b16`, tree `67152288bf2e083f9c756cd6e5553c8902ec11a8`.

This standalone D1 safety fix intentionally changes accepted behavior; it is not a pure controller extraction. Real `useSelectedController` tests on the base reproduced a wallet prompt after unmount during prepare and archive/current writes plus broadcast after unmount during signing. A captured ready callback also started preparation after unmount. Paired mounted and initial StrictMode submissions passed on the base.

## Ownership and preserved behavior

A synchronous layout-effect lifetime token gates entry, prepare/sign continuations, broadcast followups and attempt reconciliation. Each effect setup receives a new token, so cleanup/setup cannot revive an old continuation. The synchronous submission lock remains held until the old promise settles, preventing double prompts; retained state is cleared even when settlement occurs while effects are disconnected, so a reconnected instance can then unlock. Catch/error and reconciliation results require the originating lifetime. No wallet/selection epochs were added: existing identity equality, input revision and expiry checks retain their meaning, including their existing ABA limits.

Before broadcast, obsolete work cannot prompt, persist or send. After persistence and broadcast start, cleanup never deletes or reclassifies the attempt. Accepted, rejected and lost responses from the obsolete controller cannot initiate status/state refreshes. A fresh mount reads and queries the original signature; an explicit fresh operation remains possible while old history is pending/manual/invalid. There is no automatic retry, re-sign or re-broadcast.

SelectedAttempt v2 keys, fields, raw history archive and write/readback order are unchanged. The durable record contains the original signature and reconciliation inputs; signed transaction bytes remain in the original send payload, not a new storage field. Prepare still has its 20-second deadline; successful prepare clears it before wallet waiting. Wallet waiting may exceed that deadline but still must satisfy prepared expiry.

## Evidence boundaries

Tests use the actual hook with React createRoot/act, happy-dom, fake time and deferred boundary responses. They cover prepare/sign unmount, stale callbacks, durable deferred broadcast with remount, stale status notifications, independent new-controller progress, StrictMode initial replay, and Activity effect disconnect/reconnect retaining refs. Both settle-before-reconnect and reconnect-before-settle orders are covered, including durable accepted/rejected/lost responses. Independent review caught the previously missed hidden-settlement busy lock; unconditional stage cleanup fixes it without relaxing side-effect ownership. The Activity fixture detects boolean-only lifetime resurrection; it is an adversarial lifecycle harness, not a claim that this app uses Activity. Positive paths check call order, payload/message bytes and original signature. Existing history warnings, archive/readback, late input, expiry and synchronous double-click controls remain covered.

The nonzero 64-byte mock signature is synthetic, not cryptographic or financial validity proof. No real wallet/RPC, financial operation, hosted CI, deploy or production verification is part of this implementation. No Withdraw, compound, open, engine, route, API or storage-schema code is changed. D2/D3 and the broader controller phase remain unfinished.

The workspace report `output/sofinance-selected-lifecycle-implementation-20261027-r1.md` and its same-stem evidence folder bind commands, RED/GREEN logs, source/build identity, fresh validation and explicitly reused integration evidence. Prior PR155 delivery tracking is based on root's `sofinance-selected-submit-production-verification-20261027-r1.md` and `sofinance-pr155-merge-receipt-20261027.md`.
