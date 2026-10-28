# Readonly closure transport follow-up

Scope: test harness only. Delivered in PR [#168](https://github.com/truenorth-lj/sofinance-public/pull/168), merge `b96d55631a173a4c7fef0808c1744ca53c632b87`.
No app, engine, backend, dependency, lockfile or prototype changes.

Response processing and disposal errors are collected independently before classification.
Any generic, foreign-owner or non-Error rejection keeps the callback failed even if cleanup
also reports owned cancellation; multiple owned cancellations produce one cancellation event.
The regression matrix and original reviewer fixture probe cover the former false-green case.

The PR167 production homepage teardown failed; its remaining eight journeys and metadata
were not run. PR166's getBalance completion remains UNKNOWN. No historical result is upgraded.
The predecessor response-delivery fix did not cover handlers skipped by Playwright 1.64.

The offline-before-close candidate was rejected with a real transport counterexample:
late same-origin keepalive telemetry and forbidden requests reached loopback after offline ACK
when page close skipped their handlers. Sources, traces and failing assertions are preserved.
The original event-observer closure controls against the exact partial HEAD also remain RED.

The replacement uses a deny-only HTTP proxy configured before creation of the browser context.
It has no upstream connection/tunnel path. Pinned Chromium sends HTTP(S)/WS(S), including loopback,
through it; tests with no routing verify denial and proxy-disabled controls reach the same sinks.
Normal app runtime stays online. Allowed single-hop requests use an independent API client and
are fulfilled into the browser, with cookie/header/body controls and no redirects/retries.
The two fixed unauthenticated MCP actions retain their separately scoped unproxied client.

The policy still records skipped requests as outcome UNKNOWN. Its independent transport
containment is a separate classification, never inferred from close timing, request failure,
status -1, sendBeacon acceptance or an empty sink. After successful owned close, contained
external/telemetry observations need not fail; forbidden operations always fail. Active-run bypass,
foreign close/disposal, crashes, and surfaced generic fulfill/dispose/close errors remain failures.
Raw route-only contexts retain the original fail-closed UNKNOWN behavior. Wallet stub callbacks
are now directly owned and drained; ordinary hermetic guards and callers remain unchanged.

The actual readonly fixture attaches audit evidence even on close errors. Regression controls
cover skipped fetch/keepalive/beacon, two pages/two owners, held allowed responses, redirects,
already-entered fulfill, stubs, workers, WS, concurrent close, cookies and explicit API isolation.
There is no universal OS/DNS/UDP/WebRTC/WebTransport or hostile-test-code claim. QA-L1 and SEC-L1
observability limits remain. Original production exceptions remain immutable; a separate root-verified production R2 is recorded below.

Detailed commands, retained failures, fresh/reused evidence and final local identity:
workspace `output/sofinance-prod-readonly-closure-implementation-20261028-r2.md`.
Production R2: **PASS_SCOPED_PRODUCTION_READONLY**, deployment `dpl_HCjUnHibD5TPjuBhXbc17BcNnDBf`, 9/9 single-result retry0, all 16 descriptors/key order equal and stable canonical identity. Root readback verified 103 hashes/seven audits. CI `40595912837` passed policy68, fresh hermetic66 retry0, PostgreSQL26, app4677/engine474 per environment lane and network-disabled container.

Historical PR166 UNKNOWN, PR167 failure and PR168 R1 incomplete runner evidence stay unchanged. R2 retains one closing telemetry UNKNOWN with independent proxy containment; a genuine getBalance attempt was observed aborted and proxy-isolated, not zero attempts or universal provider isolation. Financial behavior **NOT_EXERCISED**. These are historical delivery receipts, not P3a release proof.

Sources: workspace `output/sofinance-prod-readonly-closure-production-verification-20261028-r2.md` and `output/sofinance-pr168-production-root-readback-20261028.json`.
