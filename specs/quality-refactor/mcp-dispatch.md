# Typed MCP dispatch (PR2)

Approved implementation of the 2026-10-27 shared-usecases design, sections 3.1, 4 and PR2.
Base: `5ab102a4cd626cd627af0326555b0dc0feec6be2` (metadata PR152 merged and production verified).
This phase consolidates dispatch only; the full shared-usecases stage remains incomplete.

## Ownership and types

`src/mcp/dispatch.ts` owns every metadata `ToolName`'s parser, missing-arguments mode,
wallet binding and handler. `defineTool<Input, Output>` closes over the schema's parsed
input type, runs parse then binding then handler, and exposes an unknown-input execution
function. The handler and wallet accessor cannot widen the inferred schema type.
`satisfies Record<ToolName, ...>` enforces coverage; runtime tests check both discovery
surfaces for uniqueness and exact dispatch coverage. No new framework or dependency.

Context is `{surface: 'mcp-http', tokenWallet: string} | {surface: 'mcp-stdio'}`.
Only the HTTP adapter constructs authenticated context after successful existing verification.
Raw arguments cannot choose surface, token wallet or binding. Required-match: list_positions,
quote_add_liquidity, prepare_transaction, quote_compound, prepare_compound_transaction,
submit_signed_transaction, submit_compound_transaction, quote_open_position,
prepare_open_position, submit_open_position, prepare_withdraw, submit_withdraw.
Optional-match: get_position_performance, get_position_range_status. None: list_rwa_pairs
(get_pool_activity was removed). HTTP authenticates every tool; stdio has no token gate. Optional wallet
stays omitted, never populated from context. Compare only parsed wallet values.

Only performance/range/pairs use `args ?? {}`; all others parse raw args.
Prepare compound uses quoteCompoundSchema. Preserve schema defaults, stripping, transforms,
refinements, validation errors and parse-before-wallet precedence. Lookup uses an own-property
check, rejecting prototype names with the existing `Unknown tool: ...` wording. HTTP and SDK
retain their different malformed-name/arguments rejection contracts.

The withdraw submit schema outputs `Record<string, unknown>` for summary, while the existing
handler/send signature requires `WithdrawSummary`. That pre-existing trust boundary cannot
be proved by the schema. Localize the old assertion to this summary alone in the dispatch
adapter; do not claim it validates the record. Preserve the object and all its fields, and
leave deserialize → permit → impact/structure → signature → RPC/simulation/send validation
inside the existing lazy send handler. Do not strengthen the runtime schema, change permit
serialization, widen the sender API, or cast the registry/whole parsed command to hide it.

## Transport boundaries

HTTP keeps public initialize/ping/list/notification 202, Bearer/secret/verify order,
malformed envelope/params behavior, status/error envelopes, Sentry and both catches.
Stdio entry keeps its first-import server-only shim, startup and fatal handling. A
`createMcpServer()` registration seam enables real SDK in-memory testing; it has no env
backdoor. SDK framing and tool error sanitization remain in that adapter. Registry creation
must not read signing secrets, create RPC connections, execute handlers or eagerly import
withdraw build/send modules. Existing engine host setup is preserved.

`tools.ts`, runtime schemas, metadata and discovery goldens remain unchanged. No prepare
use-case extraction, transaction algorithm, accepted-send metadata or unknown-send change.

## Acceptance and evidence

Before replacing either switch, capture both entrypoints with all 16 names: actual HTTP
POST/auth/Zod and registered SDK Server via in-memory transport. Freeze parsed arguments,
exactly-one correct handler, pretty JSON serialization, undefined/null/empty/malformed args,
wallet policies, invalid-schema precedence, omitted optional wallet, injected context fields,
unknown/prototype/non-string names and backend/serialization error envelopes. Keep these
snapshots unchanged after implementation. Actual child process tests cover startup,
discovery and early rejection only; vi.mock does not cross process boundaries.

Also run real handlers through both entrypoints with synthetic builder/read backends, and
all four submit pipelines with deterministic disposable signed fixtures, real HMAC code,
mocked RPC/state/simulation. Verify bytes, I/O arguments/count/order, invalid permit before
backend, accepted metadata failure and no false safe-to-retry/unsent outcome. These are
local synthetic tests, not transaction or release approval.

Local gates: focused tests, lint, app/engine/e2e types, full unset/dummy environment lanes,
real SDK child discovery/rejection, fresh production Next build and 66 hermetic E2E tests
with zero retries, plus built HTTP protocol/auth/early-rejection probes. Native Vitest loader
and owned cache; short owned TMP and process groups; only this checkout's dependencies.
No product dotenv/credentials or external RPC/signing/broadcast. Reuse PG/container/pack
receipts only with exact relevant source/config/dependency closure identity and explicit
reused labels; 26 skipped PG tests in ordinary suites are never passes.

Evidence lives outside the product in workspace `output/sofinance-mcp-typed-dispatch-implementation-20261027-r1.md`
and its matching folder. Final handoff is local clean commits for independent Code/Security/QA
review; no push, PR, merge, deployment, or financial/global-release PASS in this task.
