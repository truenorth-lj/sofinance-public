# Store operation/result contracts

Base: `ed936bb8edeaef2cd90e34cb06ce560ccfab17ec` (Meteora PR #246).

## Change and boundaries

`RwaStore.request` and `PositionHistoryStore.request` now infer their results
from the request operation. The 11 RWA operations and three history operations
have explicit result maps. Their concrete Postgres implementations use mapped
handlers, so returning a result for the wrong operation is a compile error.
Request parsing and database identity checks still precede dispatch; the existing
SQL, lease fencing, transaction scope and operation ordering are unchanged.

Foreground reads, refresh jobs and history sync no longer assert the result's
type. The unconstrained `storeCall<T>` wrapper is removed. Postgres integration
tests also use inferred snapshot types. Nullable lease claims stay nullable.
A compile-only contract file covers concrete and interface inference, dynamic
request unions, missing inputs and invalid handler results, including negative
`@ts-expect-error` checks that must remain errors under app typecheck.

Two assertions remain at the internal HTTPS gateway JSON boundary, and one at
each validated request parser to preserve its generic discriminator. The gateway
annotation is a compile-time wire contract, not new runtime response validation;
older gateway compatibility and its existing error handling are unchanged. This
batch does not claim to reject malformed successful gateway JSON at runtime.

Shared recovery primitives were evaluated separately in [the decision](shared-primitives.md).
Existing signing/secret helpers are reused; protocol-specific persistence and
ownership remain explicit. Opens logging has its own database target and will
get a separate migration batch, without putting its DDL into the RWA database.

## Evidence

- First app typecheck identified incompatible old test doubles: null history
  release results, cache-only unused stores, and untyped icon-write results.
  Those now use the operation contract or throw if accidentally invoked. A
  transport-failure observer explicitly accepts either result shape. The initial
  diagnostics remain in `typecheck-first.log`.
- STATIC: final full app/engine typecheck and lint passed; app typecheck includes
  the compile-only positive and negative contract checks. The first lint run
  caught a late-initialized test variable; it now uses explicit fixture state.
  `git diff --check` passed after removing a trailing empty line.
- BEHAVIORAL: 80 targeted store/routing/cache/deadline/sync/icon tests passed.
  Full app suite passed 5,473 tests, with 27 DB-dependent tests skipped across
  four files. The final fixture-only lint fix passed all 11 icon tests afterward.
- `pnpm build:rwa-service` passed. Engine behavior tests were not rerun because
  engine source did not change; hosted CI runs the full environment matrix.
- FINANCIAL NOT_EXERCISED: no wallet or chain transaction. Database integration
  requires its dedicated test URL and remains for hosted PostgreSQL CI.

Logs: workspace `output/sofinance-store-contracts-20261030/`.

Local self-review checked each handler against its original switch branch,
actual SQL projection, consuming jobs and generic call inference. Automated
OpenCode/MiniMax review remains unavailable; no independent approval is claimed.
No schema/data migration, configuration change or financial flag activation is
part of this batch. The prior dirty Compound worktree remains untouched.

All six hosted checks passed on `4aa2883`; no new review findings. PR #248
merged as `ee6f5ecf947f4b75b93b5c6fb263e5946bf0189a`. Its successful Vercel
deployment `4Ek3UbBVbWt3wDKdjoMN5tWDEzSM` matches the production `/app` HTML
on 2026-10-30. This verifies the served build identity, not financial behavior.
