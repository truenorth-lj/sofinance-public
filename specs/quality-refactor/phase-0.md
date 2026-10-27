# Phase 0: transaction safety and quality gates

Base: `e530b5ccf8cf4cf2f0a5e7e748931e6da6bb6332`.

## Changes

Open and compound submissions keep an unknown result once RPC send begins. The engine retries/fails over internally and exposes only its final error: a final preflight rejection cannot prove an earlier attempt was never accepted. Local validation and simulation failures before send still report `sent:false`. The original signature stays pending for reconciliation; a genuinely unsent RPC rejection may therefore remain locked until expiry evidence is available.

API console output now snapshots and scrubs errors, stacks, causes and structured properties before logging. Diagnostics retain safe names/stacks without passing raw error objects or inspection hooks to console.

CI runs the environment matrix, PostgreSQL 18 integration tests and hermetic E2E against a production build. Node 24 matches the service Docker image. The E2E build command and server share configuration, the modal connection helper handles terms consistently, and deployed MCP smoke expectations include all 16 existing tools.

## Initial local validation

- Environment unset and dummy-config suites: **2,387 tests passed each**; 26 database tests intentionally skipped in these two lanes.
- Dedicated disposable PostgreSQL 18: **26 passed**; zero leftover test schemas, owned cluster stopped.
- Production AppKit build and hermetic E2E: **62 passed**, no retries; fake wallet and mocked broadcast routes.
- Lint, TypeScript, RWA bundle and migration drift checks pass.
- Targeted probes cover real RPC retry wrappers with mocked physical sends, including timeout then preflight rejection; message bytes and original signature are unchanged.

Independent review then reproduced additional Bearer, quoted JSON and encoded-URL redaction gaps. The shared text scrubber and public response sanitizer now cover these forms, with 81 targeted tests passing. Final full-suite and build receipts are attached to the PR at its exact head.

These are local checks. Independent review, hosted CI and exact-commit deployment verification are recorded with the PR. No mainnet signing, broadcast or financial outcome is asserted. Prototype is paused and untouched; engine migration is a separate change.
