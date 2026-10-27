# Readonly teardown follow-up

Scope: test harness only, based on merged PR167 (`da4ce5a63b20c2b0c17ba0d2406dfad1983b99b6`).
No app, transaction engine, backend, dependency or prototype changes.

The first corrected-harness production run failed in the homepage teardown: a late
`route.fulfill` failed after page close, and one forbidden-class request had no handler.
The remaining eight journeys and metadata check were not run. This remains a historical
failure, separate from PR166's provider-read attempt with completion UNKNOWN.

The local correction starts ownership before page close, gives pages and context the same
unique shutdown reason, and disposes allowed responses acquired across shutdown without
attempting late delivery. Redirect violations, generic failures and foreign cancellation
reasons remain failures. The shared production fixture is also exercised by loopback tests;
ordinary hermetic fixtures and guards are unchanged.

**Incomplete closure coverage:** Playwright 1.64 can observe a request but skip its handler
when page/context closing begins. Such requests still fail closed as UNKNOWN. Sanitized
observations record scope, hostname, method, resource, a local ordinal and observation phase;
no path, query, body, credentials or application identifiers are added. No `requestfailed`,
status -1, `sendBeacon(true)` or zero sink result is used as proof of blocking.

Local real Chromium regressions distinguish response-delivery scheduling controls from
natural transport and fixture tests, and include guard-disabled sink controls. A local
pass is not evidence that the original production UNKNOWN was blocked or is now resolved.
The original production trace has insufficient request correlation to identify its
unhandled request conclusively; the late telemetry config remains a candidate only.

Full root handoff, baseline failures, commands, source/build identities and limitations:
workspace `output/sofinance-prod-readonly-teardown-implementation-20261028-r1.md`.
Production remains **NOT_REVALIDATED** and financial behavior **NOT_EXERCISED**. Root owns
independent reviews, hosted CI, delivery and any subsequent production run. The skipped-handler
case remains an explicit blocker to a complete teardown/isolation success claim.
