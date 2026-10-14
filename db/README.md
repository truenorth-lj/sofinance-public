# RWA database migrations

`src/db/schema.ts` is the typed Drizzle schema. Commit schema changes together with
`drizzle/*.sql` and `drizzle/meta/*`; the generated SQL is reviewed before applying it.
`PostgresRwaStore` uses Drizzle ORM for reads, joins, upserts and transactions. The
few PostgreSQL-specific statements (lease timing and atomic daily roster insert)
use parameterized Drizzle `sql`.

```sh
pnpm db:generate                 # generate a migration locally; no database connection
pnpm db:baseline                 # one-time adoption of the existing five tables
pnpm db:migrate                  # apply pending committed migrations
```

The CLI reads `SOFINANCE_RWA_MIGRATION_DATABASE_URL` from `.env.local` or its process
environment. It must identify database `sofinance` and role `sofinance`, matching
the current single-role setup. Runtime continues to use `DATABASE_URL`.

Baseline first builds the initial migration in a disposable schema and compares
columns, defaults, constraints and indexes with the existing tables. It refuses
drift or a partial schema, then records the initial migration in
`drizzle.__drizzle_migrations` without rewriting business tables. Repeating it is
safe before any subsequent migrations. An existing schema without a registered
baseline is refused by `db:migrate`; a fresh database runs the initial migration.
Both commands share an advisory lock and validate migration checksums before
calling the official Drizzle postgres-js migrator. Changing already applied SQL
is refused; create a new migration instead.

Migrations run explicitly as a deployment step, never during page requests,
service startup or Next.js build. Deploy the Zeabur RWA gateway bundle after
migration and local verification: that service runs the ORM against private
PostgreSQL. Vercel continues to read its authenticated HTTPS endpoint. Discovery
runs every 15 minutes, APR every 5 minutes, and the daily history rule is unchanged.

Position performance uses two additional tables: `position_history_state` for
fenced synchronization progress and `position_history_transactions` for receipts
and parsed event arrays. Apply the committed migration and deploy the gateway
before setting `SOFINANCE_POSITION_HISTORY_DB_ENABLED=true` on Vercel. Position
history updates only when queried; the existing RWA scheduler does not scan it.
Current prices, liquidity and unclaimed fees are still read on every lookup.

Opt-in integration tests create and remove only disposable schemas in the
dedicated database:

```sh
RWA_DB_TEST_URL='<test connection>' pnpm exec vitest run \
  src/db/migrations.integration.test.ts \
  src/lib/rwa-postgres-store.integration.test.ts
```
