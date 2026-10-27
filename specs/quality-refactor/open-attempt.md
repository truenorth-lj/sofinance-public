# P3a Open attempt state model

Local implementation candidate only; independent root Code/Security/QA review is still required. Accepted base `b96d55631a173a4c7fef0808c1744ca53c632b87`, tree `575fbf2957d3108315a1f04555c73daa4310e3c1`. P3b preview and P3c submission remain later work. No prototype or remote delivery.

## Ownership and contract

`transactions/open/open-attempt-model.ts` owns only the in-memory unloaded/empty/invalid/tracked union, pure reducer and wallet/pending selectors. Tracked history includes status null after dismissal and the retained unsent receipt. Empty history retains an error field because verification failures update the current queued state, rather than always replacing it. The model has only type imports, no React/browser/storage/network/commands.

`use-open-attempt.ts` retains load, reconcile, track, markUnsent, retry, effects and synchronous active/wallet/attempt/checking refs. All four refs are written at their original points. Load timer0, poll timer0/3000, composed timeout10000, effect order/dependencies/cleanup, current closures, status allowset and original-signature matching remain in this hook. No epoch/latest-ref/restoration policy is added.

Public keys remain `{attempt,status,error,pending,loaded,track,markUnsent,dismissTerminal,retry}` with unchanged nullability and callback recreation. Track and markUnsent are synchronous and can throw. Track completes durable persistence/readback, then sets the synchronous owner, then publishes. MarkUnsent calls the durable helper before checking currentness, including stale callbacks after unmount.

Errors apply to the latest queued state; dismissal carries the invoking render's captured snapshot. Dismissal retains attempt/storage while clearing status/error. The extra invalid-kind narrowing at dispatch is redundant with the unchanged pending predicate for every reachable wallet state, not a new dismissal policy. Reducer transitions never trigger commands.

Modal/controller and SIGN runtime files are unchanged. Open remains a wallet-level pending lock, including other pools, unread/invalid history and manual review. Selected/Compound warning policy is not generalized. Modal same-pool position/submit-stage, error precedence, confirmed Beam and createAnother behavior remain at their existing consumers. SIGN accepted submission/redirect semantics and all non-open kinds remain unchanged. OpenAttempt v1 keys, raw bytes, archive/unsent helpers, API/engine and dependencies are untouched.

## Evidence and preserved limits

Tests-first commit records accepted implementation behavior before runtime changes. Real hook, real modal controller plus Open hook, and real SIGN page plus Open hook use React DOM/act/happy-dom, existing synthetic signed fixtures and boundary fetch/storage faults. Before/after raw ledgers include committed public state, request body/order, signed bytes, storage operations, errors and counts. Model tests cover immutable receipt/error/lock projections. Existing modal tests and hermetic J7/J2/J3 remain gates; no mocked Open hook is used.

Preserved baseline limits (not introduced or repaired here):

- A retained dismiss callback can restore its captured older receipt projection even after a newer track; durable storage still contains the newer receipt.
- Manual retry can accept the original signature after wallet A-B-A if the same wallet/signature owner is restored.
- Suspense layout reconnect clears attemptRef without replaying history load; manual status results remain ignored and track is blocked until a full remount reloads history. Activity and StrictMode have their own characterized effect replay behavior.
- With a response adapter that ignores the composed timeout during slow JSON, the original current predicate can still accept its result. The timeout signal is passed unchanged; this is not a claim about all browser fetch implementations.

No safety correction is hidden in this extraction. Selected L1/B1 stay out of scope. Full commands, first failures, mutation controls, manifests, build binding, fresh/reused gates and cleanup are recorded in workspace `output/sofinance-open-attempt-model-implementation-20261028-r1.md` and its same-name evidence directory. Local synthetic results are not release or financial proof. FINANCIAL NOT_EXERCISED; overall P3–P7 and typed-store/analytics work remain unfinished.
