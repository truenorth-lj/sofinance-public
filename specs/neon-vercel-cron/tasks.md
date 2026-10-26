# Implementation tasks

Scope: application, tests and documentation only, at `6422286f073b82e9aa4a844604563286a883ebb7` on `dev/neon-vercel-cron`. Parent owns cloud, secrets, export/import and cutover. No commits, push, PRs or delegated agents.

- [x] Read approved spec/design/constraints, checkout AGENTS, installed Next route/environment guides, existing stores and migrations.
- [x] RED: configuration, secure direct Neon client, shared routing and GET/POST rollout tests.
- [x] GREEN: explicit gateway/neon selection; shared bounded server-only pool; strict TLS, target validation and direct-only runtime.
- [x] Shared refresh handler and bodyless normal GET; separate default-off native cron flag; 15-minute Vercel schedule.
- [x] Preserve lease/epoch/due grace/generation/daily/last-good/position receipt/parser/delta fences; SQL regression and timeout recovery.
- [x] Environment matrix/guard, example and migration/cutover recovery docs.
- [x] Native pnpm lint/typecheck/test/env-matrix/build; isolated local PostgreSQL checks; implementation summary with exact results and remaining cloud gates.

Local verification completed on PostgreSQL 18.3 with two disposable local roles:
legacy `sofinance` and explicitly selected `sofinance_owner`; four SQL files,
26 tests passed per role. No cloud connection, migration/copy or cron activation
was performed. See `implementation-summary.md` for exact checks and ownership.
