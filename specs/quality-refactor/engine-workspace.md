# Engine workspace migration

Public's active engine source now lives in `packages/engine`. Root application code uses
`workspace:*`; prototype is paused and untouched. This is an exact-source move, not an upgrade
to prototype's divergent 0.2.0 line.

## Identity and boundaries

Imported the complete `packages/engine` subtree from `engine-v0.1.6`, commit
`060aa926a2ee9c7ec7af2b82c38122a769c6d5aa`. All 90 runtime files match the previously vendored
artifact byte for byte. The original 63 test files, fixtures and snapshots are preserved.
Source and artifact digests are recorded in `packages/engine/provenance.json`.

Web/API/MCP policies, host configuration, permits issued by routes, persistence and UI remain
in the application. Deep exports and TypeScript-source packaging are unchanged. No prototype
application, sponsor signer, credentials, environment files or private app persistence moved.

The engine retains its UNLICENSED metadata. A package-local license notice prevents `pnpm pack`
from implicitly copying the root MIT license. No registry package is published.

## Tooling

- Root tests/typechecks run separate app and engine suites. Root Vitest excludes package tests;
  the engine uses its own host setup. Root ESLint still checks package source and tests.
- The environment matrix runs both suites in unset and dummy-config environments.
- Docker copies engine source before frozen workspace installation, then ships only the RWA bundle.
  CI builds that container and checks boot/auth with networking disabled.
- Retired the tarball update script, old vendor artifact and obsolete root npm lock.
  The independent E2E npm lock remains.

## Migration validation before integration

At the e530b5c application baseline, lint and both typechecks pass; app tests: 2,361 passed,
26 database tests skipped; engine: 63 files, 468 tests passed. Both suites also pass under the
environment matrix. Next production webpack build passes. The existing MCP test launches the
real stdio server and compares all 16 tool definitions with HTTP without calling product backends.

Docker build passes; the standalone image starts without node_modules/workspace source and
returns 401 for an unauthenticated store request with external networking disabled. The owned
smoke container is removed. This does not validate a real database connection or deployment.

Local pack contains 94 files: 90 unchanged runtime files, manifest, README, provenance and
package license notice; tests/fixtures/snapshots are excluded. Gitleaks' 13 findings are the
13 `tables[].key` fields in three transaction fixtures; each is a 32-byte Solana public address,
not an API credential. No generic suppression or secret-bearing fixture was added.

Final integration with the transaction/logging foundation receives its own exact-head checks
and independent review. Local fixtures and browser checks do not establish mainnet financial
outcomes. The immutable import digest is a migration baseline, not a claim about future revisions.
