# Opens analytics migrations

The optional opens log uses `SOFINANCE_OPENS_DATABASE_URL`. It is independent of
RWA's database, schema and `drizzle/` ledger. Its source is
`src/db/opens-schema.ts`; `drizzle-opens/` contains the generated SQL, snapshots
and journal. The runtime only inserts and reads; it no longer creates tables.

## Rollout prerequisite

Before deploying runtime-DDL removal, confirm whether production logging is
configured. If it is disabled, no database migration is needed. If configured,
verify and migrate that exact database first. Do not infer its state from the
local `.env.local`, a successful application build, or the RWA migration ledger.

Provide these variables securely to the CLI, never in a commit or command-line
argument containing credentials:

- `SOFINANCE_OPENS_DATABASE_URL`: the existing runtime target.
- `SOFINANCE_OPENS_MIGRATION_DATABASE_URL`: a direct connection to the same
  endpoint/database, using a role allowed to create the migration ledger and
  disposable verification schema. The role may differ from the runtime writer.

The CLI requires both values, verifies their target match and verifies the
connected database/role/search path. It rejects pooled migration endpoints,
connection-option injection and nonmatching databases. Remote TLS verifies the
certificate and hostname. A separate session lock serializes these migrations;
they do not run inside application requests or as part of a Vercel build.

## Existing table created by the old runtime

```sh
pnpm db:opens:baseline
pnpm db:opens:migrate
```

Baseline builds the initial generated schema in a disposable namespace and
compares PostgreSQL's column types, defaults, nullability, constraints and
indexes. A match registers the initial migration in
`opens_drizzle.__drizzle_migrations`, without modifying business rows. A mismatch
stops for investigation; it does not drop, truncate or recreate the existing
table. Repeated baseline/migration is safe. Original timestamp-default behavior
is preserved, including the database's existing timezone semantics.

## New empty database

```sh
pnpm db:opens:migrate
```

The command refuses to migrate over an existing unregistered opens table. An
edited or unknown migration ledger also fails. No command falls back to
`DATABASE_URL` or `SOFINANCE_RWA_MIGRATION_DATABASE_URL`.

## Verify and evolve

After migration, verify the ledger and schema, then use the existing authenticated
opens-daily report to confirm reads. Do not fabricate an open or send a financial
transaction merely to test logging. Existing rows and signatures must remain.
Deploy the application only after the configured target has passed adoption or
fresh migration. If read/write permissions are reduced later, do that as a
separate explicitly scoped change; this migration does not alter grants.

For schema changes, edit `src/db/opens-schema.ts`, then run
`pnpm db:opens:generate` and review the generated SQL. Do not edit an applied
migration. CI verifies generation stays clean and exercises fresh/adopted schemas
against PostgreSQL 18 in disposable namespaces. Local tests accept only an
explicit `OPENS_DB_TEST_URL`.

The frozen `src/db/opens-legacy.fixture.sql` is historical test input, not a
second schema source. Logging remains best effort: a missing schema makes its
insert fail without delaying a broadcast; report reads return the existing
unavailable response. That failure isolation does not replace the rollout gate.
