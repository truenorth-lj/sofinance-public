# Opens log migration verification

Base: `ee6f5ecf947f4b75b93b5c6fb263e5946bf0189a` (store PR #248).

## Scope

Move opens analytics schema ownership from runtime CREATE TABLE/INDEX calls to
`src/db/opens-schema.ts` and generated `drizzle-opens/` migrations. RWA's existing
schema/migration directory stays separate. Insert idempotency, query behavior,
optional logging configuration and best-effort broadcast isolation stay intact.
The old SQL is frozen solely as a legacy adoption test fixture.

The CLI requires explicit opens runtime and migration URLs, checks matching
host/database/port, rejects migration poolers and unsafe URL options, and uses
verified remote TLS. It validates connected database, role and search path,
holds a dedicated session advisory lock, checks migration checksums, and uses
the supported Drizzle migrator. Existing tables require structural baseline
verification before adoption. No business rows are rewritten or deleted.

CI now checks both generated migration directories and runs the opens integration
suite in disposable PostgreSQL 18 schemas. See [rollout procedure](../../docs/opens-migrations.md).

## Validation

- STATIC: app/engine typecheck and final full lint passed. First lint rejected an
  unused query-mock argument; an explicit callable mock type fixes it. The final
  app typecheck covers that adjustment and the reviewed cleanup path.
- Generated SQL/snapshot/journal hashes remained identical after
  `pnpm db:opens:generate`; `git diff --check` passed.
- BEHAVIORAL: full app suite passed 5,488 tests; 37 tests were skipped across five
  DB-dependent files in that run. The ten opens DB tests were run separately
  against a dedicated local PostgreSQL 14.15 instance and all passed. CI supplies
  PostgreSQL 18; no claim that local PostgreSQL 14 covers every PostgreSQL 18 behavior.
- Focused tests cover missing/mismatched targets, TLS/direct endpoints, URL
  option rejection, insert-only/query-only runtime paths, fresh migration,
  legacy adoption, row preservation, repeated execution, lock contention,
  identity mismatch, schema drift and edited migration checksums.
- First DB run: 9 passed, 1 failed. Drizzle's registration changes timestamp
  deserialization from Date to string, so a raw-row comparison falsely differed.
  The fixture now compares PostgreSQL `row_to_json(...)::text`, preserving full
  timestamp precision and numeric values. No migration behavior was changed to
  bypass the preservation assertion. The first output remains archived.
- After self-review made reserved-session release unconditional even if advisory
  unlock fails, all ten DB tests passed again. The local server was stopped in
  `finally` after each run.
- FINANCIAL NOT_EXERCISED: no real wallet, transaction or financial data changes.
  Live opens-database state has not been inspected or migrated.

Logs: workspace `output/sofinance-opens-migrations-20261030/`.

## Deployment hold

The canonical local environment, current shell and local Vercel env-file paths
do not supply opens database configuration. No Vercel environment connector is
available, and the earlier CLI scope lookup lacked project access. These facts
do not prove that production logging is disabled. The user has been asked whether
production `SOFINANCE_OPENS_DATABASE_URL` is configured; that answer is pending.

Keep this PR draft until either production logging is confirmed disabled, or the
configured opens database has been verified and adopted/migrated using its own
credentials. If credentials are needed, request them through the host's private
secret card. Do not merge merely because CI passes. No new permission to perform
routine migration is needed; the missing prerequisite is target/access information.

Self-review covered the complete runner, transport target checks, generated
baseline against historical DDL, CLI error sanitization, runtime DML paths and
rollout order. OpenCode/MiniMax review remains unavailable; no independent approval
is claimed. Hosted CI, live database readiness, merge and deployment are pending.
