# Opens analytics retirement

User decision: remove opens analytics code, 2026-10-30. Base: main
`a5c9f4a3de965a54743fa2d8452f48e617e1b8c8`.

The optional server opens log, SQL schema, connection configuration, daily
JSON/CSV API and their dedicated tests are removed. Open broadcast and sign
clients no longer forward `sourceRef`; browser PostHog events and first-touch
attribution remain. The existing Postgres dependency serves RWA/position stores
and is retained.

Meteora no longer exposes or calls the analytics-only `record` action. Deposit
success settles from the matching confirmed transaction status, guarded by the
existing wallet/lifecycle and pending-record identity checks. Uncertain sends
retain their original signatures. Existing position discovery reads the chain.
Old clients calling `record` receive an invalid-request response on enabled
Meteora deployments; the prior client handles that optional response after
confirmation and still clears the matching pending receipt. Production's
Meteora feature gates remain unchanged.

No database connection, migration, table drop, data deletion or remote environment
change is part of this retirement. Any existing opens database and rows remain
untouched. Old deployments may still use their original configuration. This code
removal is not database-resource decommissioning or financial validation.

## Superseded work

Migration [PR 249](https://github.com/truenorth-lj/sofinance-public/pull/249) is
closed as superseded, not merged. Its schema/migration files never landed on main and are
not imported by this change. Historical Neon migration specifications retain
their data-preservation requirements for any existing opens rows.

## Validation

Validation results are recorded with the retirement PR and in workspace
`output/sofinance-retire-opens-20261030/`. Focused regression checks cover confirmed
deposit completion without analytics, delayed status versus replaced pending
records, rejecting retired API actions before RPC work, open broadcast permit/
signature behavior, both open clients, and retained PostHog attribution.
Local results: 227 focused tests and 5,459 full app tests passed (27 database
cases skipped). The strengthened prepared-transaction forwarding suite passed
42 tests. Lint, application/engine typecheck and the production build passed.
The build manifest contains both transaction routes and no opens-daily route.
PostHog modules, engine, RWA migrations and dependencies are unchanged.
Self-review completed; independent OpenCode/MiniMax review was unavailable.
Financial flows NOT_EXERCISED.

Integration follow-up: merged main `279d3c1` (APR PR 247) without conflicts.
The retirement runtime patch is unchanged; PostHog, engine and RWA migrations
match that base. Full app tests, lint and app/engine typecheck passed again;
hosted checks must rerun for the synchronized head.
