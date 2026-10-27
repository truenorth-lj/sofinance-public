# Selected preview extraction (P2a)

Accepted base: `39bf882300e720284622bd98c6bb0fda2dfa6776`, tree `080e0fbfb68de36be7d90daa6acc1b63b39fa93a` (includes D1 lifecycle safety, PR160 relay behavior and delivered P1). This is a local preservation refactor, awaiting root's fresh independent reviews and delivery. P1 production receipts are historical and do not cover this slice.

## Ownership

`transactions/selected/use-selected-preview.ts` owns the unchanged idle/quoted state, loading, quote error/code/outputMint, request and refresh revisions, 450ms debounce, 20s preview deadline, expiry minimum 1s, visibility subscription and cleanup. It exports two cooperating hooks so state commands exist before the parent's reset effects while the quote effect remains registered after the original reset, discovery/state, clock and history effects. `start` and `quoteRevision` are preview-owned effect ports; no facade refs are handed to the reader.

Stable `invalidate`, `clear`, `clearErrors` and `adopt` ports preserve distinct reset timing. Wallet/selection reset and amount/tolerance commands invalidate at their original synchronous points; wallet's zero-delay reset clears errors, selection's zero-delay reset only clears preview and amount. Retry clears only its original quote state and increments refresh revision. Prepared results are adopted without inventing a new request invalidation policy.

The facade still owns wallet/form, discovery/state reads, input parsing/readiness, quote/result/fresh/status projections, single one-second clock, attempt/history/reconcile and the entire submit command. Its return object is unchanged. Submission input revision and D1 layout lifetime tokens remain independent. The panel retains its original relay store; a stable getter supplies that same instance to preview, while prepare uses it directly. Near-amount cache behavior remains in the existing relay implementation. `RELAY_DEADLINE_MS` remains publicly exported by the facade; prepare retains its independent timer.

`selected-preview-model.ts` contains only original types, selection identity and the shared deadline constant. No new state union, generic transaction framework, storage schema, service/engine dependency or financial policy was introduced. `passesFloor` remains informational.

## Preservation evidence

Tests were committed before runtime extraction as `e197e20f75418037e5ed6ddfa9e8c22f7f35cb0c`. `selected-preview.test.tsx` runs the real facade and relay with deterministic wallet/HTTP boundaries and records every committed projection, raw request body/path/time and side-effect counts. `selected-preview-caller.test.tsx` uses real SelectedApp, Selected and Compound controllers and DOM buttons (Next routing is the framework mock). All 53 new cases have identical raw ledgers on the accepted source, extracted source and an exact accepted Git-blob loader overlay. No product files are replaced for replay or mutations. Post-freeze test changes supply explicit spy types and use the existing relay-origin constant to satisfy the repository host-literal guard; assertions and runtime test logic are unchanged.

Coverage includes exact debounce, raw input and reply identity validation, input/selection/wallet ABA, synchronous invalidation before passive cleanup, stale success/error/finally, StrictMode/Activity, deadline/retry, expiry/visibility/unmount, unsupported/invalid inputs and healthy recovery, object/callback churn, shared preview/prepare cache (including 1% near-amount behavior), quote/submission error priority and actual caller error/Recalculate and busy coordination. Existing real-facade D1 Activity/Suspense tests, caller tests, relay tests, quote/prepare tests and J5 browser readiness controls supplement this suite. No new hook is mocked.

Six loader mutations fail behavioral assertions: disabled synchronous invalidation, stale-error guard removal, omitted debounce cleanup, 449ms debounce, retry without revision and a separate relay cache. Healthy originals pass. Static comparison additionally confirms identical discovery/state, history/reconcile, D1 guards, readiness/status, public return bytes and submission body (apart from preview setter ports).

The reproducible local run record is workspace `output/sofinance-selected-preview-implementation-20261028-r1.md` with its same-name evidence directory. It records all failed harness/implementation runs, exact final source and build identity, native-loader/no-cache OS-network-denied unit/matrix results, lint/app/engine/E2E types, loopback-only fresh committed build and hermetic browser results with retries zero, plus post-build types. Independent review and release are separate gates.

## Limits

### Independent follow-up: repeated-input liveness (C1)

After the preservation extraction, independent review reproduced an existing bug on both accepted base and extracted HEAD `4e794322`: clicking MAX again while a quote is pending invalidates the old response but leaves the amount unchanged, so no replacement effect runs. Same-render amount/tolerance A→B→A commands have the same failure.

A separate fix commit adds `invalidateForInput`: synchronous request invalidation plus a refresh revision. Only amount/tolerance commands use it; wallet/selection resets, prepared-result adoption, submission input revision, busy/readiness gating and the 450ms debounce keep their previous behavior. This is an explicit behavior improvement, not a claim that the baseline already handled repeated inputs correctly. Four regression cases fail on the pre-fix runtime and pass after the fix: actual MAX late success/rejection and batched amount/tolerance ABA, with healthy replacement, exact debounce and no automatic prepare/sign/send/storage writes.

The original 53-case preservation evidence remains frozen. New fix evidence is workspace `output/sofinance-selected-preview-c1-rework-20261028-r1.md`; it requires fresh independent review and final build/CI before delivery.

HTTP/provider responses and wallets are synthetic. Pure preview cases assert zero prepare/sign/send/storage-write/history-notify effects. Explicit prepare cases stop at the mocked HTTP boundary. Existing browser suites use synthetic wallet signing, never real funded operations. STATIC and BEHAVIORAL evidence is scoped local; FINANCIAL is NOT_EXERCISED.

PR163 hosted CI run `40534030872` tested synthetic merge tree `080e0fbfb68de36be7d90daa6acc1b63b39fa93a`, equal to the accepted merge. Its database lane passed 26 tests and its standalone container smoke ran network-disabled. These are reused hosted receipts for the unchanged engine/service closure, not fresh local services or P2a CI. Local database skips remain skips. Older `cef3154` engine pack/PostgreSQL/Docker proof is not reused; a current packed consumer is unverified in this client-only slice. P2b/P2c and all subsequent controller/storage/analytics work remain unfinished.
