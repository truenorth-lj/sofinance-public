# Implementation summary: public Neon and native cron

Date: 2026-10-26 Asia/Taipei. Checkout:
`/Users/lj/Documents/projects/lj-agent-workspace/worktrees/dev/neon-vercel-cron/sofinance-public`.
Branch: `dev/neon-vercel-cron`; unchanged HEAD/base:
`6422286f073b82e9aa4a844604563286a883ebb7`. All changes are uncommitted.

## Implemented behavior

- `SOFINANCE_RWA_STORE_MODE=gateway|neon`, default `gateway`, controls both stores.
  Existing HTTPS gateway and non-Vercel private PG service remain compatible.
  Neon ignores the stale gateway value and fails closed on any DB/config error.
- Shared server-only postgres-js runtime pool for RWA and position, with bounded
  max/connect/query settings, prepare disabled, idle/lifetime bounds. Explicit
  **direct runtime**, not the unproven transaction pooler. Known `-pooler` Neon
  endpoints are refused; no automatic fallback or insecure TLS mode.
- URL fixed DB `sofinance`, explicit role default `sofinance` or selected
  `sofinance_owner` using `SOFINANCE_RWA_DB_EXPECTED_ROLE`. No arbitrary role/DB
  allowlist expansion. Both runtime and migration SQL identity checks compare
  that setting; runtime also requires PG17+. Parent's actual public target uses
  PG18 and its existing `sofinance_owner`; no role/password was created/reset on
  Neon. Unit tests reject wrong SQL role/database/version and retry transient
  identity failures. Actual SQL suites passed under both local roles.
- Neon TLS uses trusted CA plus hostname validation, including URL sslmode=require.
  Startup parameters cannot be injected through URL query. Allowed SSL/channel
  hints are validated then stripped; this client does not promise SCRAM channel
  binding. Every direct runtime session receives schema search_path, configured
  statement timeout, 3-second lock timeout, 8-second transaction timeout. Original
  transaction-local timeout/fence logic remains. Migration keeps a separate URL,
  direct reserved advisory-lock session, max=2, no runtime-URL fallback and
  existing 30-second statement/5-second lock limits. Existing migration SQL,
  ledger format and schema were not changed.
- GET/POST share auth, refresh/preview gates, response/error handling and refresh
  implementation. Bodyless GET ignores all query parameters and always passes
  force=false. POST preserves strict JSON and optional boolean force. Responses
  are no-store; route ceiling stays 300s. Raw DB errors do not reach the direct
  store's public error or refresh exception capture.
- `vercel.json` declares `*/15 * * * *` UTC for the GET route. Separate
  `SOFINANCE_RWA_NATIVE_CRON_ENABLED` defaults false, so rollout cannot activate
  the new writer while the old POST timer still operates. POST continues working
  with this flag off. Existing job cadence/deadlines, due grace, epoch/lease,
  generations, daily immutable samples, last-good APR and position receipt/parser/
  revision/delta fences remain. A 15-minute cron does not imply five-minute APR.
- Environment guard ratchets the three new routing/role settings at one read
  each in config modules. Matrix now exercises real rollout controls (unset and
  dummy Neon-enabled) without an opt-in SQL URL. Three existing tests explicitly
  pin their intended reader/canonical configuration to prevent ambient env from
  selecting real DB/network paths; no unrelated product behavior was changed.
- DB docs and cutover runbook cover all writers/old deployments, verified DB-level
  source fencing, seven tables plus ledger/dependencies, optional opens and
  source_ref, scoped restore drill, canonical ordered data hashes and full cursor/
  receipt manifests. They prohibit switching back to stale source after destination
  accepts writes and distinguish data, cron and retirement acceptance stages.

## Verification

Read checkout AGENTS and installed Next 16.3.6 route-handler/environment docs
before code. Followed red/green: first focused run failed on 17 new expectations
plus the absent client suite (14 existing expectations passed); implementation
then passed focused tests. No production secrets or .env copies were used.

All final commands exited 0:

| Check | Result |
| --- | --- |
| `pnpm lint` | Passed; eslint --max-warnings=0 |
| `pnpm typecheck` | Passed; tsc --noEmit --incremental false |
| `pnpm test` | 283 files passed, 4 opt-in SQL files skipped; 2,340 tests passed, 26 skipped |
| `pnpm test:env-matrix` | Unset and dummy Neon-enabled each: 283 files passed/4 skipped, 2,340 tests passed/26 skipped |
| `pnpm build` | Passed Next 16.3.6 webpack production build; refresh route emitted dynamic |
| `pnpm build:rwa-service` | Passed; existing gateway bundle still builds with shared client |
| `git diff --check` | Passed |

Opt-in SQL command (local disposable PG18.3 cluster, never a cloud target):

```sh
RWA_DB_TEST_URL='<private test target>' pnpm exec vitest run \
  src/lib/rwa-database.integration.test.ts \
  src/lib/rwa-postgres-store.integration.test.ts \
  src/lib/position-history-postgres-store.integration.test.ts \
  src/db/migrations.integration.test.ts
```

Ran once with legacy `sofinance` and once with explicit
`SOFINANCE_RWA_DB_EXPECTED_ROLE=sofinance_owner` and that local role's URL:
**4 files / 26 tests passed in each run**. Disposable schemas exercise migration
adoption/checksums/preservation/session-lock exclusion; lease takeover/stale-owner
rejection/due grace/duplicate and missed tick; generation/daily immutable/missing
and last-good data; receipts/parser/revision/delta fences; bounds on each reserved
connection, non-transaction statement cancellation and lock cancellation.
Eight-second transaction_timeout produced an actual server FATAL termination
(the driver can report ECONNRESET), rolled back the inserted row and allowed a
subsequent bounded query. This runs in a one-connection pool and asserts a changed
backend PID, so recovery cannot be supplied by an unaffected second connection.
Client teardown is bounded after a fatal disconnect.
Temporary local cluster was stopped and removed after tests.

The first expanded env-matrix run exposed ambient reader/canonical assumptions;
those test fixtures were corrected and both full matrix legs passed afterward.
The first transaction-timeout assertion expected only SQLSTATE 25P04; PG18/driver
returned ECONNRESET. The test now checks supported termination codes plus actual
rollback and recovery, with bounded teardown. No timeout/fence was relaxed.

Build emitted bigint optional-native-binding fallback notices and existing
request.url static-render diagnostics for pool-daily-apr/rwa-pairs; build still
completed successfully and routes are dynamic. JetBrains lint was attempted with
this exact projectPath, but this checkout is not open in the IDE (only another
project was open). Native lint, typecheck, tests and build supply the checks.

## Parent-owned gaps and next steps

This is **code ready for parent review and actual-target validation**. No claim
of data migrated, cron alive, service retirement, production readiness or cloud
completion is made. No cloud APIs, credentials, exports/imports, commits, pushes,
PRs, deployments or subagents were used.

Parent must privately inject direct Neon URLs and set expected role
`sofinance_owner` in runtime and CLI. Native cron stays disabled until the parent
proves all-writer source fencing, final-copy hashes/cursors/receipts/ledger/opens
and lease disposition. Parent still owns actual Neon TLS/identity/startup/timeout
checks, direct connection capacity and cold-start/job deadline evidence, source
catalog/consumer inventory, scoped backup/restore and post-write recovery drill,
Vercel target/SHA readback and public/prototype smoke, two real GET writes and
freshness advances plus daily window, and old-service retirement evidence.
Pooler compatibility is unproven and intentionally unsupported. Optional opens
remains separately configured; it was neither silently moved nor certified.
The actual production gateway hostname from the parent is
`sofinance-rwa.zeabur.app`; the older local hostname is stale. Prototype untouched.

## Modified paths

The three parent-supplied approved spec/design/constraints files were preserved.
Task-owned modified/new paths (relative to this checkout):

- `.env.example`
- `README.md`
- `db/README.md`
- `db/neon-vercel-cutover.md`
- `scripts/rwa-migrate.ts`
- `scripts/test-env-matrix.sh`
- `specs/neon-vercel-cron/implementation-summary.md`
- `specs/neon-vercel-cron/tasks.md`
- `src/app/api/internal/rwa-refresh/route.test.ts`
- `src/app/api/internal/rwa-refresh/route.ts`
- `src/app/api/pool-range-apr/route.test.ts`
- `src/db/connection.ts`
- `src/db/migrations.integration.test.ts`
- `src/db/migrations.ts`
- `src/db/target.ts`
- `src/lib/blog.test.tsx`
- `src/lib/config/rwa-database-env.ts`
- `src/lib/config/rwa-env.test.ts`
- `src/lib/config/rwa-env.ts`
- `src/lib/config/rwa-migration-env.ts`
- `src/lib/env-reads.guard.test.ts`
- `src/lib/position-history-postgres-store.ts`
- `src/lib/position-history-store.test.ts`
- `src/lib/position-history-store.ts`
- `src/lib/rwa-database.integration.test.ts`
- `src/lib/rwa-database.test.ts`
- `src/lib/rwa-database.ts`
- `src/lib/rwa-postgres-store.integration.test.ts`
- `src/lib/rwa-postgres-store.ts`
- `src/lib/rwa-store-routing.test.ts`
- `src/lib/rwa-store.test.ts`
- `src/lib/rwa-store.ts`
- `src/mcp/tools.test.ts`
- `vercel.json`
