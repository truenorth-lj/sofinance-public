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
environment. Database stays `sofinance`. `SOFINANCE_RWA_DB_EXPECTED_ROLE` defaults to
`sofinance`; set it explicitly to `sofinance_owner` for the new public Neon target.
Only these two role values are accepted. URL and SQL identity guards both compare
against the selected role. Never create/reset the Neon owner password to satisfy
the legacy default. Runtime uses `DATABASE_URL`; CLI never falls back to it.
Neon migration URLs must use the direct endpoint with CA and hostname verification.
The CLI still reserves a direct session for its advisory lock and uses `max: 2`.
Never run session advisory locks through the pooler.

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
service startup or Next.js build. Do not edit applied migration SQL or use destructive
schema push. Existing gateway mode remains the default for compatible rollout.
`SOFINANCE_RWA_STORE_MODE=neon` selects one shared server-only postgres-js pool for
RWA and position on Vercel, ignoring any stale gateway URL. A connection failure
fails closed; it cannot select the gateway implicitly. See
[the cutover procedure](neon-vercel-cutover.md) before changing production writers.

This implementation deliberately selects **direct runtime**, because transaction
pooler startup settings are unproven. `-pooler` hosts are rejected, `prepare:false`
remains set, and every direct session gets `search_path`, configured
`statement_timeout`, `lock_timeout=3s`, `transaction_timeout=8s` at startup. The
existing transaction-local eight-second fences remain. PG17+ is required (public
target is PG18); URL options cannot override these settings. TLS uses trusted CA
and Node hostname validation; no insecure fallback. The first store operation
also verifies `current_database()`, `current_user` and PG version before business SQL.
Only URL `sslmode=require|verify-ca|verify-full`, `sslrootcert=system`, and
`channel_binding=require|prefer` hints are accepted and removed before postgres-js
startup parsing. The TLS setting is independently enforced; this client does not
claim SCRAM channel-binding support.

`vercel.json` declares GET `/api/internal/rwa-refresh` at `*/15 * * * *` UTC. Native
GET remains disabled unless `SOFINANCE_RWA_NATIVE_CRON_ENABLED=true`. Both methods
require Bearer `CRON_SECRET`, refresh enablement and a non-preview deployment.
GET ignores query parameters (including force) and takes no body; POST keeps its
strict JSON contract and authorized force option. Tick cadence is 15 minutes;
discovery/APR due cadences remain 15/5 minutes, so APR is not refreshed every five
minutes by this cron. Daily observations remain 08:10–09:10 Asia/Taipei; missed
windows remain missing, never fabricated.

Token icons use `rwa_token_icon` (`drizzle/0002_token-icons.sql`): one row per token
(`chain`, `address`) holding an icon link (never an image file) and its `source`. The
daily rwa-discovery job fills it after the pool scan (Solana: Jupiter → Raydium →
manual list; Robinhood Chain: DexScreener → GeckoTerminal → manual list), keeping only
links on `ICON_HOSTS`. `/api/rwa-pairs` returns them as `tokenIcons`. The migration is
not applied by the build or the cron: run `pnpm db:migrate` against the target (on the
public Neon target with `SOFINANCE_RWA_DB_EXPECTED_ROLE=sofinance_owner`). Until then,
or while the table is empty, reads return the manual list only and the cards fall back
to Raydium's icon path and initials; the save step records an issue and does not fail
discovery. The next cron after the migration fills the table.

Position performance uses two additional tables: `position_history_state` for
fenced synchronization progress and `position_history_transactions` for receipts
and parsed event arrays. Apply the committed migration and deploy the gateway
before setting `SOFINANCE_POSITION_HISTORY_DB_ENABLED=true` on Vercel (or verify the
Neon store after migration and copy). Position
history updates only when queried; the existing RWA scheduler does not scan it.
Current prices, liquidity and unclaimed fees are still read on every lookup.
Each lookup fetches at most `maxSignatures` transaction details (1–500, default
100). The reader resumes incomplete history on subsequent views. A position is
bounded to 10,000 stored signatures and 3.5 MB per snapshot; oversized metadata
fails closed, and raw receipts are replayed within a byte budget.
Complete history also has an eight-second process cache (64 entries, 8 MiB).
It caches neither ownership nor current valuation. A changed position-account
fingerprint misses the cache; successful transaction verification invalidates
it. Browser dirty markers send `refreshHistory=1` across server instances and
retain required signatures until finalized history includes them (or finalized
failure is verified). Pending history and errors are never cached. MCP callers
can use `refreshHistory` and `historyAfterSignatures` for the same guarantee.

Opt-in integration tests create and remove only disposable schemas in the
dedicated database:

```sh
RWA_DB_TEST_URL='<test connection>' pnpm exec vitest run \
  src/db/migrations.integration.test.ts \
  src/lib/rwa-postgres-store.integration.test.ts \
  src/lib/position-history-postgres-store.integration.test.ts \
  src/lib/rwa-database.integration.test.ts
```
