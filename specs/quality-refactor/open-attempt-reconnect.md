# Open attempt ownership across Suspense reconnect

Base: PR170 merge `bc4c1317f492343185942b142c6cfcd025f0f331`.

The hook's wallet layout effect cleared the synchronous attempt reference every
time React reconnected layout effects. Suspense preserves the hook and does not
replay its passive history loader in this case. The existing receipt remained in
the UI, but status results were ignored until a full remount.

The wallet layout effect clears ownership only when the committed wallet changes.
A same-wallet Suspense reconnect retains the actual synchronous reference,
including `null` after unsent cleanup;
it must not reconstruct ownership from a stale render snapshot. The active flag
continues to reject callbacks while effects are disconnected. Wallet changes
still clear ownership before passive history loading.

Activity also replays passive effects. When its history loader starts, detach the
previous owner before the deferred read, and keep it detached if the read fails.
Only a successful read can restore the saved owner. This prevents an old manual
reply from unlocking history while it is being revalidated or after it becomes
unreadable, without changing Suspense's layout-only reconnect behavior.

Regression checks cover retained pending/manual-review polling without storage
reads or writes, an unsent receipt remaining detached, hidden settlement followed
by successful reconciliation, and a wallet switch while suspended. Existing
unmount, Activity, StrictMode, late-unsent, modal and SIGN controls remain.

This is a focused behavioral correction, separate from the pure Open model
extraction. The retained-hook scenario is reproduced locally; a specific
production Suspense trigger at this transaction stage has not been established.
Cross-tab atomicity, durable uncertainty across remount, retained dismissal,
manual ABA and signing-controller lifecycle are outside this change.

Root evidence: `output/sofinance-open-attempt-reconnect-20261028-r1/` in the
workspace. Baseline: 42 passed / 3 expected failures. Initial correction: all
94 focused tests passed. That version passed full validation and initial reviews,
but the post-push review found a P1: an Activity history read failure left an old
manual query able to remove the conservative lock. The corrective tests also
reproduce replies arriving before the history timer; a catch-only fix is
insufficient. Corrective evidence is in workspace
`output/sofinance-open-attempt-reconnect-rework-20261028-r2/`: 105 focused tests
and the four original reviewer probes pass. Eleven new cases fail against the
prior runtime; removing either detachment guard is detected. Corrected-HEAD full
validation and independent review remain pending. No real wallet, provider or
financial operation was performed.
