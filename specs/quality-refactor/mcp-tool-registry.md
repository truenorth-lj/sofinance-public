# MCP discovery metadata consolidation

This is the first part of the approved shared HTTP/MCP use-case phase. It moves discovery
metadata into one app-owned module while preserving each transport's observable output.
Dispatch, runtime schemas, authorization, transaction builders and submit behavior stay with
their existing owners for this change.

## Delivery status

Merged in PR [#152](https://github.com/truenorth-lj/sofinance-public/pull/152) as
`5ab102a4cd626cd627af0326555b0dc0feec6be2`; production identity, nine read-only checks
and complete discovery parity verified on 2026-10-27. The implementation notes below
record the earlier local phase. Typed dispatch is tracked separately in [PR2](mcp-dispatch.md).
The broader shared-usecases stage is not complete.

## Contracts

`src/mcp/tool-definitions.ts` owns all 16 definitions. `listToolDefinitions(surface)` returns
detached plain data. The HTTP list keeps its order; stdio keeps compound submission last and
its existing `quote_open_position.resaleFloorBps` description. No other schema, description,
default, required field or ordering changes are intended. No Zod-to-JSON-schema conversion
is introduced because discovery metadata and runtime validators have different contracts.

The module has only an erased SDK type import and cannot load handlers, engine configuration,
providers or secrets. A TypeScript AST guard rejects runtime imports, re-exports, import-equals,
literal/computed dynamic imports and require calls; synthetic forbidden-edge cases exercise
the guard. This checks module edges, not arbitrary runtime/global effects.

## Verification sequence

Before changing production metadata, complete HTTP JSON-RPC discovery and real SDK stdio
`listTools()` snapshots were captured and passed against the original implementations. The
snapshots live beside the existing stdio characterization tests. They are not regenerated
from the new registry. After replacing both literal lists, the same snapshots and all existing
HTTP auth/dispatch tests must pass without updating expected output. The obsolete withdrawal
source-string wiring test is replaced by actual entrypoint snapshots and registry coverage.

The first implementation base is `fda07b0c34844c1d72cb024ba02aa95a22a42850`, on the unmerged
engine/cleanup stack. Snapshot-only baseline commit is `92de55c`. Foundation credential fixes
are being reviewed separately; before delivery, rebase onto the accepted foundation and
preserve the snapshots and production metadata diff. Current local focused result is 94 tests
passed; lint and app/engine typecheck also passed. Final integration and independent review
remain separate gates. This
receipt does not claim deployment or financial validation.

Next planned changes are typed dispatch with explicit per-surface wallet binding, followed
by operation-specific prepare extraction and a narrowly shared selected-submit core. They
must preserve validation order, signed bytes, permit serialization and unknown-send handling.
