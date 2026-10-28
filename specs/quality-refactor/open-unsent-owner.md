# Open late-unsent ownership correction

Follow-up to PR169 SEC-B1 on accepted base `411e0f8f4469fa73c8d5ce4787a9ee45927a05bc`. This is a safety correction, separate from the P3a model extraction and later preview/submission refactors. Prototype is unchanged.

## Problem and behavior

While S0 awaits broadcast response, another tab can save S1 and archive S0. A late `sent:false` response previously left S1 durable but projected S0 as unsent, unlocking the modal. The user could prepare/sign again; the later track guard prevented another broadcast. This is a reproduced synthetic controller scenario, not a proven production incident.

The unsent helper now returns true only after archiving and removing its matching receipt with readback. Missing or replaced history returns false. Parsing and archiving use the same raw read, with an additional equality check immediately before deletion. Observed replacements are retained.

The hook keeps durable cleanup before its active/wallet/signature checks, including stale callbacks after unmount. If cleanup fails or does not release the receipt, the current owner detaches old status callbacks and reloads durable history. Valid saved history becomes the pending owner; malformed, missing or unavailable history remains locked for verification. The failure still propagates synchronously so neither modal nor SIGN can advertise the old response as safe to retry. A different active owner or wallet is not overwritten. Successful matching cleanup retains the normal unsent receipt and retry behavior.

## Validation and limits

Real helper, hook, modal controller and SIGN page regressions exercise late unsent, replacement with/without a StorageEvent, stale status, missing/corrupt/unreadable history, wallet change, no extra preparation/signature/broadcast, preserved raw archives and recovery after the newer signature expires. Existing ordinary unsent, archive/remove faults and stale-unmount cleanup remain controls.

localStorage has no atomic cross-tab compare-and-swap. The equality check catches observed replacements but cannot promise serialization between separate calls or across tabs. This does not install a global storage-event listener, solve general concurrent writers, or persist an uncertainty latch across remounts. A remount reloads current durable history under the existing policy. Retained Suspense ownership, retained dismiss and manual-retry ABA limitations remain separate follow-ups. No API/engine/schema changes; no financial operations.

Full local commands, first RED/GREEN logs and delivery receipts are in workspace `output/sofinance-open-unsent-owner-20261028/` and its implementation report. Evidence is scoped to its recorded source identity; production smoke is not an actual transaction test.
