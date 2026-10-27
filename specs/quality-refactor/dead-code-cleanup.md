# Confirmed dead-code cleanup

This change removes app-internal exports that no active route, UI or script consumes. It follows
the engine workspace migration; it does not alter engine runtime source. Repository-wide symbol
and import searches, the existing entrypoints, TypeScript and retained behavior tests determine
scope. Historical specifications are evidence of former behavior, not proof of a current caller.

## Removed paths and callers

| Removed code | Evidence and retained path |
| --- | --- |
| `position-performance-query-panel.tsx` and its fallback | Its only consumer was its own test. The old page already redirects query parameters to `/app?view=performance`; the current app renders `PositionPerformancePanel` directly. |
| `parsePerformanceQuery`, `queryFromSearchParams`, private `firstQueryValue` | Used only by that obsolete query wrapper and its tests. Current wallet/form helpers remain. |
| `InkHeader`, `InkButton`, their barrel exports | No UI callers; active Ink components remain exported. |
| `PoolAprSparkline`, `AprSparkline`, `calendarizeDailyApr`, `lastCompleteDayAprCopy` | No consumer of the outer sparkline; inner helpers were only consumed by that retired chain/tests. `AprLineChart`, daily APR panels and active calendar utilities remain. |
| `formatHistoryFetch` | Test-only exported formatter; current performance component does not call it. |
| `lp-exit-rpc.ts` | Its retry/error wrapper had no app caller. Current exit preview uses engine RPC and preview logic. |
| `compoundCost` | Only its own tests called it. `CompoundOverview` still consumes the retained `tokenUsdValue` and `formatUsdcValue`. |
| Goal-first `lp-intent` evaluator/types and `paceToTarget` | No current UI/API caller. The live Plan uses `lp-plan-intent`, best historical APR selection and compounding. Keep `parseUsdc`, `parseDays`, limits and `ExitAsset`, used by Plan setup and its sentence controls. |
| `amountToAtomic`, `normalizeLedger`, `historicalNet`, `hodlNet`, `exitNet` | Former ledger/goal calculations, referenced only by retired intent logic or their own tests. Keep `atomicUnits`, request schema, cost/scenario calculations and observation types. |
| `extractWalletFromToken`, `isTokenExpiringSoon` | No consumers outside their tests. Existing wallet authentication/verification functions remain. |
| `src/mcp/index.ts` | Unused barrel; the package command starts `src/mcp/server.ts`, while HTTP imports its actual tools directly. |

The independent `/api/lp-decision` route, performance redirect, all transaction routes, MCP tool
registrations, permits, stored attempt schemas and compatibility handling remain. This app is
private and does not publish its `src/lib` exports as a package API. Engine exports are unchanged.

Tests solely for removed behavior are removed with it (34 cases, two complete test files).
Mixed suites retain their active assertions, including exact atomic precision, costs/scenarios,
wallet auth, Plan parsing, charts and position performance. This is retirement of unreachable
features, not a change to their numerical formulas. README now describes actual Plan network
reads, 16 MCP tools and the engine/app ownership and RPC paths.

## Validation

Before rebasing onto the final credential fix, the cleanup patch on engine commit `86e7c062`
passed root lint and app/engine typecheck; app suite: 284 files passed, four DB files skipped,
2,383 tests passed and 26 DB tests skipped. Logs are in the workspace output directory under
`sofinance-cleanup-{lint,typecheck,test}-20261027.log`. These are local patch receipts, not final
commit, deployment or financial evidence. Final integration checks and independent review must
bind the final cleanup commit after the foundation/engine stack is settled.
