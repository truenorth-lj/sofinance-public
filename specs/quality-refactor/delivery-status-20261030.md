# Quality refactor delivery status — 2026-10-30

Verified against `origin/main` at `ee6f5ecf947f4b75b93b5c6fb263e5946bf0189a`.
This map updates stale candidate labels. It does not turn historical UNKNOWN,
failed, skipped or NOT_EXERCISED evidence into a pass.

## Delivered code

| Area | Current source / merged evidence | Boundary |
| --- | --- | --- |
| Engine ownership and shared HTTP/MCP use cases | `packages/engine`, `src/server`, `src/mcp`; PRs #150–#155, detailed receipts in [tasks](tasks.md) | Paused prototype remains unchanged. Surface policy and transaction semantics stay explicit. |
| Selected controllers | `transactions/selected/use-selected-preview.ts`, `use-selected-attempt.ts`, `use-selected-submission.ts`; #164–#166 | The PR166 provider-read UNKNOWN and later readonly harness receipts retain their original meaning. |
| Open attempt model | `transactions/open/open-attempt-model.ts`; [#169](https://github.com/truenorth-lj/sofinance-public/pull/169), `411e0f8` | Late-unsent ownership corrected in [#170](https://github.com/truenorth-lj/sofinance-public/pull/170), `bc4c131`; Suspense reconnect corrected in [#171](https://github.com/truenorth-lj/sofinance-public/pull/171), `fd2f525`. |
| Open preview | `transactions/open/use-open-preview.ts`; [#172](https://github.com/truenorth-lj/sofinance-public/pull/172), `bd2e6ec` | Same-value input restart corrected in [#173](https://github.com/truenorth-lj/sofinance-public/pull/173), `e5d412a`. |
| Open submission | `transactions/open/use-open-submission.ts`; [#174](https://github.com/truenorth-lj/sofinance-public/pull/174), `7b853c9` | Retained-command revocation corrected in [#178](https://github.com/truenorth-lj/sofinance-public/pull/178), `44edaa0`. |
| Compound snapshot and confirmation | `transactions/compound/use-compound-position-snapshot.ts`, `use-compound-attempt.ts`; [#163](https://github.com/truenorth-lj/sofinance-public/pull/163), `39bf882`; [#184](https://github.com/truenorth-lj/sofinance-public/pull/184), `d928b65` | Confirmation extraction is narrow; submission, recovery and feedback still have facade ownership. Do not call this all of P4 or all controller decomposition. |
| Later dead-code/cycle cleanup | [#240](https://github.com/truenorth-lj/sofinance-public/pull/240), `024a5e5` | Keep the merged engine cleanup. Its cycle claim was not independently rerun by this documentation update. |
| SOL, RHC, Compound and Meteora recovery | [#243](https://github.com/truenorth-lj/sofinance-public/pull/243), [#244](https://github.com/truenorth-lj/sofinance-public/pull/244), [#245](https://github.com/truenorth-lj/sofinance-public/pull/245), [#246](https://github.com/truenorth-lj/sofinance-public/pull/246) | Per-batch tests, hosted checks and deployment identities are recorded in [follow-up tracking](../quality-followup-20261030/TODO.md). Synthetic tests are not financial validation. |
| Store response contracts | [#248](https://github.com/truenorth-lj/sofinance-public/pull/248), `ee6f5ec` | Operation/result maps cover concrete handlers and callers. Gateway JSON remains an explicit compile-time wire trust boundary. |

All component paths in the table are under `src/components/` unless otherwise
qualified. Merge identities for the older Open/Compound phases were checked in
main's history; their earlier independent reviews and production receipts were
not rerun as part of this cleanup.

## Still open

- On 2026-10-30 the user requested removal of opens analytics code. Migration
  [#249](https://github.com/truenorth-lj/sofinance-public/pull/249) is superseded
  by [code retirement](../quality-followup-20261030/opens-retirement.md). Existing
  database resources and rows are preserved; removal still requires delivery.
- The broader Compound/controller decomposition is partial. A narrow confirmation
  extraction, recovery fixes, or the shared-primitives assessment does not mean
  every submission/recovery/UI responsibility has been extracted.
- Selected L1/B1 and the other historical baseline limitations keep their original
  recorded status. This cleanup neither revalidates nor resolves them. Preserve
  original first failures and UNKNOWN records when planning subsequent work.

## Cleanup evidence

Main #240 deleted `src/lib/protocol-adapters.test.ts` but left its snapshot. A scan
of `src/` and `packages/` found that file was the only `.snap` without its matching
test source; no other source referred to it. Remove only that orphan. Snapshots
with live source tests remain.

RHC discovery, build and trading constants are enabled on production, preview
and development; wallet signing is enabled on production/preview and disabled
on development. Comments now match those existing values. The disabled-wallet
message no longer names an obsolete PR approval milestone. No flag, provider,
chain, fee or transaction calculation changed.

Local validation: 75 targeted tests passed across protocol flags, wallet guards
and the RHC panel. Lint and application/engine type checks passed. Static
comparison confirmed the flag code is unchanged after removing comments.
This was self-reviewed; no new independent review was available.

This cleanup is documentation, one disabled-state message and an orphan test
artifact. It is not a new protocol release or a complete financial/security audit.
