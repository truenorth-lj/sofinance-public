# Quality refactor

Approved scope: implement the 2026-10-27 architecture audit incrementally. Base: `e530b5ccf8cf4cf2f0a5e7e748931e6da6bb6332`.

The public app, HTTP API and MCP should share one versioned transaction engine and application use cases. Consolidate the engine under `packages/engine`, retaining package boundaries; prototype is paused and must remain untouched. Its source is read-only migration evidence; consumer migration there is deferred until that project resumes. Compare its current source with public's vendored 0.1.6 before migration because prototype already declares 0.2.0.

## Delivery sequence

1. Transaction submission uncertainty and API log redaction, with regression tests.
2. Executable CI coverage: production Next build, hermetic browser flows, real PostgreSQL integration and environment matrix; repair the E2E build command and wallet-connect helper.
3. Engine ownership migration with source provenance, package checks and consumer compatibility; remove the obsolete root npm lock and confirmed dead code.
4. Shared HTTP/MCP use cases and tool registry, preserving each surface's explicit policy.
5. Transaction-attempt state and controller decomposition, preserving wallet-switch, reload, finality, recovery and cleanup behavior.
6. Typed storage contracts and analytics migrations; document final module ownership.

Each reviewable change must pass relevant checks before merge. Do not combine calculation changes, permit serialization changes and module moves.

## Acceptance criteria

- A timeout followed by a retry preflight rejection retains the original transaction signature for reconciliation. Only failures known to occur before broadcast may report definitely unsent.
- Provider credentials in an error message, stack or nested cause never reach API console logs or client responses.
- CI executes database integration tests against a disposable PostgreSQL 18 service, production builds and hermetic browser tests; no real credentials or funded wallets.
- Engine source is maintained in one repository, for the active public app, with reproducible workspace dependencies and tests. The paused prototype retains its existing snapshot and is outside this change. Migration must account for every production source difference.
- Shared use cases retain message bytes, account/signature validation, amount bounds, fees, permits and known surface policy differences.
- Dead code removal requires caller evidence; external routes and persisted-state compatibility are not declared dead from import analysis alone.

## Constraints

Keep unrelated work intact. No destructive database migration, mainnet signing or broadcast is needed for this refactor. Local synthetic evidence does not establish financial correctness or deployed identity. Verify the deployed commit separately after merge.
