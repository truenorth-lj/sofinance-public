# Portfolio history snapshots

Approved scope: LJ requested returning stored results first, background incremental sync, and subsequent frontend reads. Existing signature checkpoints remain the source of incremental boundaries.

- The Raydium Portfolio path with durable history enabled reads current chain balances/fees/prices and a durable read-only history snapshot. It does not wait for history RPC or acquire a history lease.
- Stale or missing history schedules bounded Next `after` work. Existing durable leases fence concurrent workers; per-process scheduling is bounded and deduplicated.
- Reuse finalized signature/delta/backfill cursors. No wall-clock transaction filter, new queue, table, or migration.
- Complete history may be displayed while refreshing with its successful sync-start time. Missing/incomplete history never becomes a fabricated zero.
- Record successful no-change synchronization. Failure, partial history and expired/stale leases cannot mark data fresh. Work started before a refresh cannot acknowledge that refresh.
- Frontend polls updating rows at eight-second intervals, with at most three follow-up rounds and eight total requests per load. It stops on success/error/budget, wallet change, pause or unmount. Polls do not repeatedly force refresh.
- Existing signature dirty markers require their finalized ledger evidence. Signature-less markers require successful synchronization started after the refresh barrier; compare-and-clear retains marker version fencing.
- Trading/signing admission, other DEX readers, the database-disabled legacy fallback and detail-report behavior remain unchanged.
- Before activating the web revision, verify the configured production store supports the new read operation. A gateway deployment (if used) must precede the web deployment.

Acceptance: deferred history RPC does not block first figures; a subsequent poll sees completed new history; cached history never clears a newer marker; same-position concurrent reads do not fan out sync work; no-change and failed-sync freshness have real SQL coverage; cold/partial/error and cancellation paths remain explicit. Validate repository checks, independent code/security/QA reviews, deployment and connected public-wallet readback.
