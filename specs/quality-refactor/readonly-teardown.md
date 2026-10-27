# Readonly closure transport follow-up

Scope: test harness only, on local `46988757429b9e4b2e74f5055b1170ada1bbaa39`.
No app, engine, backend, dependency, lockfile or prototype changes. No remote delivery.

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
observability limits remain. Original production exceptions require new root-owned verification.

Detailed commands, retained failures, fresh/reused evidence and final local identity:
workspace `output/sofinance-prod-readonly-closure-implementation-20261028-r2.md`.
Production **NOT_REVALIDATED**; financial behavior **NOT_EXERCISED**. Root owns independent review,
hosted delivery and any later production run. This local change is not release approval.
