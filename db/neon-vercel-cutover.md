# Public Neon / Vercel cutover runbook

Application implementation is separate from data migration, cron activation and
service retirement. Parent/operator owns platform changes, private credentials,
export/import and this cutover. None of those stages is certified by green local
checks. Never copy `.env.local` into a checkout or log URLs, secrets, receipts or
backup contents. Store backups and manifests in controlled private storage.

## Target and rollout configuration

Parent reported a separate Free **SoFinance Public** organization
`org-broad-firefly-60295848`, project **sofinance-public**
`nameless-leaf-36697865`, AWS Singapore, PG18, database `sofinance`, existing role
`sofinance_owner`. Direct host:
`ep-quiet-butterfly-b3ao2cj8.c-4.ap-southeast-1.aws.neon.tech`.
The corresponding `-pooler` endpoint is unsupported by this implementation.
These are parent-provided metadata, not live verification by the implementation
agent. Reported Free settings: 0.25–2 CU, 6-hour PITR, 1 GB. Measure capacity and
restore requirements before declaring them sufficient. Do not touch prototype
`neon-carmine-leaf`, its financial DB or reconcile cron.

| Setting | Store rollout | Controlled destination cutover |
| --- | --- | --- |
| `SOFINANCE_RWA_STORE_MODE` | `gateway` (default) | `neon` |
| `SOFINANCE_RWA_DB_EXPECTED_ROLE` | `sofinance` default | explicitly `sofinance_owner` in runtime and CLI |
| `DATABASE_URL` | legacy private service only | secret direct Neon URL, DB `sofinance` |
| `SOFINANCE_RWA_MIGRATION_DATABASE_URL` | separate secret direct CLI URL | separate direct migration identity; same expected role |
| `SOFINANCE_RWA_NATIVE_CRON_ENABLED` | `false` (default) | `true` only after old scheduler/source writer fence |
| `SOFINANCE_RWA_REFRESH_ENABLED` | keep existing behavior | controlled POST first, then GET |
| `SOFINANCE_POSITION_HISTORY_DB_ENABLED` | keep existing behavior | enable only against verified migrated position data |

Gateway production hostname is `sofinance-rwa.zeabur.app`; the older local
`sofinance-rwa-data` hostname is stale and is not operational evidence. Mode
`neon` ignores even a populated gateway URL, and never falls back to the source.
The same mode controls both RWA and position history. Preview refresh and existing
position write gates remain in force. Keep preview data/roles isolated as well.

## Inventory, scoped backup and restore drill

1. Read actual source database/role/schema/catalog, extensions, table sizes,
   sequences, FK dependencies, grants, migration ledger and every consumer.
   Inventory writers: old timer; refresh POST and GET; gateway write operations;
   request-triggered position claims/commits/releases; optional opens background
   insert/schema creation; old and preview deployments, scripts, MCP and other
   jobs. Inventory prototype API consumers without migrating prototype finance.
2. Back up exactly the seven public application tables and their necessary
   schema/constraints/indexes/sequences plus `drizzle.__drizzle_migrations`:
   `rwa_feed_state`, `rwa_pool_latest`, `rwa_apr_latest`, `rwa_apr_daily`,
   `background_job_state`, `position_history_state`,
   `position_history_transactions`. Verify the actual ledger schema/name and
   sequence dependencies instead of assuming a table-only dump captured them.
   Use direct connections and a scoped logical backup with consistent snapshot;
   explicitly exclude unrelated databases/tables. Retain migration checksums.
3. Separately inspect `SOFINANCE_OPENS_DATABASE_URL`,
   `sofinance_position_opens`, read/report consumers and `source_ref` attribution.
   If present, include its schema, rows, sequence and attribution in a scoped
   backup/restore and writer fence, or explicitly retain the existing store and
   document its owner/consumer and recovery plan. It is not one of the seven
   tables and is not silently redirected by the RWA mode. Blank configuration
   must not be taken as proof no historical data or consumer exists.
4. Restore into an isolated destination/test target using a direct connection.
   Test restores for schema, constraints, indexes, sequences, extensions, grants
   and ledger. Run committed migrations explicitly only when needed, preserving
   ledger adoption rules. No destructive push, no rewriting existing SQL. The
   migration session lock needs two direct connections and the expected role.
5. Record private deterministic manifests in the same consistent snapshot:
   table counts; SHA-256 of canonical row JSON ordered by primary key (for
   composite keys use all components); ledger hashes/timestamps; schema/sequence
   metadata. Use the same exporter, JSON canonicalization, timezone and NULL
   handling on both ends. Verify ordered full-row content, not only counts or
   min/max. Stream large receipts rather than truncating or omitting them.
   Record feed generation/captured/observed times, APR profile and algorithm
   versions, daily date/status/unique key, nextDue/lastSuccess, lease owner/epoch/
   expiry, and each position head/backfillBefore/deltaBefore/deltaHead/complete/
   revision/parserVersion. Include receipt/event hashes and opens source_ref.
   Keep manifests private; the review report contains only redacted summaries.

## All-writer fence and final copy

1. Deploy this code with native GET disabled. The old POST timer remains usable.
   Validate direct TLS, SQL identity, search_path, all query timeouts, lease
   concurrency and total connection capacity on the actual public Neon target.
   Pool max is per process: RWA + position share one max=3 pool by default;
   opens adds max=1 when enabled. Multiply by Vercel active instances, deployments,
   migration/backup and administrative connections. Measure cold-start, compute
   wakeup, latency and job deadlines; do not assume Free capacity is enough.
2. Enter the agreed maintenance window. Stop old timer and block all refresh
   entrypoints. Stop/drain every source writer including request-triggered
   position and opens, background promises and old deployments. Apply and verify
   a **database-level write fence** on every old writer credential/session,
   covering existing pooled sessions and owners (revoking table grants alone
   does not fence table owners). The operator chooses a source-compatible
   mechanism, e.g. revoke login/connect for dedicated old writer roles and
   terminate/drain existing sessions, or an equivalent verified DB fence.
   Coordinate shared roles before changing them; do not break unrelated apps.
   Verify actual rejected writes using each old credential path. A new-version
   feature flag by itself is insufficient. Keep source read-only/fenced.
3. Let in-flight work drain and leases expire, or use a controlled, recorded
   invalidation with epoch increase; preserve all epochs/history. Never copy an
   active lease and start two writers. Record any destination lease normalization
   separately after the equal source/destination manifest checkpoint.
4. Take final scoped backup/copy under the fence. Repeat deterministic full-row
   hashes, counts, schema/ledger/sequence and timestamp/cursor/receipt manifests.
   Missing tables, opens disposition, unexpected consumer or mismatches block
   cutover. Keep the restorable source backup and verified restore receipts.
5. Point production at Neon with mode `neon`, explicit expected role and secrets
   privately injected; keep native GET off. Drain old deployments and verify
   deployed SHA/DB identity. Use one controlled authenticated normal POST `{}`
   (no force) to verify writes. Source remains fenced. Validate pairs, full
   tracked APR model/daily history, existing position incremental sync/P&L,
   receipt/parser/delta continuity and prototype consumer contract. No financial
   signing or transactions are needed for this verification.
6. After confirming old timer cannot invoke writes, enable native GET. Record at
   least two consecutive actual GET ticks, deployment SHA, job/epoch, start/end,
   status, lastSuccess/freshness and real destination writes. Test duplicate,
   missed tick and failed/expired lease recovery. Authenticated 200/skipped alone
   is not a successful write. No automatic retry guarantee is assumed. Observe
   the 08:10–09:10 Taipei daily window and unique immutable samples/missing rows;
   a fifteen-minute tick does not provide a five-minute APR refresh guarantee.

## Recovery and retirement

Before any destination write, rollback may restore the original configuration
only after fencing destination, verifying no accepted destination writes and
controlled reactivation of the source writer set.

**After destination accepts writes, never point directly back at the stale old
DB.** Fence all destination and source writers first, drain sessions and capture
new scoped backups/manifests. Prefer forward-fix; otherwise reconcile/replay the
new rows and changed checkpoints/lease epochs/daily history/receipts/opens into a
verified restored source, and compare full manifests before activating exactly
one writer set. Never erase daily samples or receipts to make hashes match.
Record any lost sampling window as missing instead of inventing an observation.

Retire only the old SoFinance gateway/timer and its dedicated credentials after
public/prototype consumer smoke, no old dependency/traffic, a restorable backup
and post-write recovery evidence. Do not remove shared DB/server/volume resources
or prototype resources. Report code, data, cron and retirement independently.
