# Transaction prepare use cases (PR3)

Accepted base: `fae3acf952b39f4fa5df9a92c81a7b50ce9392bc` (PR153 merged and production verified).
Only prepare orchestration is extracted, in compound → selected → open → withdraw commits.
Selected submit, metadata, dispatcher, schemas, engine runtime, senders, controllers and storage
remain unchanged. The full shared-usecases phase is not complete.

## Ownership

Add, withdraw, compound, open and SOL swap-step prepare orchestration now lives in
`src/lib/dex/prepare-*.server.ts`, with lazy native builders registered by each DEX module.
Results preserve complete summaries, existing permits
and serialized transactions; withdraw retains its app build/retry/refresh sequence.
Operation-specific HTTP/MCP profiles live beside the corresponding DEX compatibility contract;
`surface-policy.ts` retains the selected-submit profiles. Trusted transports select them,
never request bodies. Compound and harvest recovery share their existing permit domain while
binding the complete operation-specific summary.

Raydium's descriptor owns the native open and position capability records. The native position UI,
homepage/deep-link Open and shared prepare services use those records. Generic `capabilities` still
describe the separate `DexAdapter` contract, and `module.enabled` still controls HTTP rollout.
A native capability refusal stops new preparation before loading a binding. Withdrawal stage-2
conversion, harvest recovery and SOL receipt reconciliation remain available independently of
new-operation availability; the withdrawal engine still verifies the first-stage permit and receipt.

Native selected quote and state reads now use registry bindings as well. Quote keeps the App's
connection/signal/retry-budget references and the MCP call's original quote-only options. State
keeps its read RPC and engine defaults; raw errors return to the transport for its existing codes.
Shared state/quote DTO entrypoints are type-only, preserve the previous type exports and infer
fields from the unchanged reader/builders rather than maintaining copied response definitions.

HTTP retains parsing, relay AsyncLocalStorage, selected deadline and retry budget, status,
headers, error handling and response projection. MCP retains its existing projection,
submitArgs, full authenticated sign-token payload, URL and instructions. Compound quote
still calls the builder without permit/sign-token requirements. Open wallet/NFT mint signatures
remain client-owned; prepare never signs either slot. All broadcast and unknown-send behavior stays in the existing owners.

Selected HTTP still passes enforceResaleFloor:false, signal and budget (retriesLeft1), with
abort checks after build and permit and final response checks in the original wrapper.
MCP still calls the builder with its original five arguments/default enforcement.
Open HTTP still uses withFeeEstimateRetry and enforce:false; MCP has no outer retry.
Withdraw HTTP still passes raw JSON to the engine parser, retries only the existing allowlist,
then refreshes/restamps/reissues the permit. MCP builds once through the lazy native binding and
never adds HTTP refresh. The existing WithdrawPrepared/previous object is not reconstructed.

The three non-withdraw use cases accept a narrow signing-key reader supplied by their adapter.
HTTP passes the existing getter. MCP lazily captures one key after builder success and reuses
it for the permit and sign token, preserving the original lifetime across the new await seam.
No key enters returned prepared data; builder failure still performs zero signing-key reads.
Six additional characterization tests pass against accepted original tools.ts and detect the
intermediate extraction's duplicate read before the correction. Withdraw retains its original
engine-permit and later token reads unchanged.

## Characterization

Before extraction, checkpoint `ee5e901c473cb60e3003baaf6a7769ed2aaf4a69` froze 84 new tests
and 87 snapshots on accepted runtime source. Original dispatch goldens remain unchanged.
Real HTTP prepare POST and HTTP MCP/registered SDK handlers exercise real tools, permits,
serialization, token verification and submit handlers; only backend I/O/builders use offline
synthetic fixtures. Each surface is compared with its own before result.

Coverage includes full responses/bytes/summary/permit/payload, backend order/count/options,
request/error precedence, source signatures, micro policy, URL precedence, retry allowlists,
relay 409/hints, deadline/abort and previous preservation. All four operations round-trip
MCP prepare → verify-sign-token → HTTP submit, preserving the open NFT partial signature,
wallet-bound permit and exact signed bytes. No real wallet/provider/financial operation.

Token snapshots verify actual HMAC, URL binding, tamper/wrong-key rejection and alternative
compression, retaining the whole authenticated payload rather than unstable deflate bytes.
The existing dispatch normalization and old goldens remain authoritative and unchanged.

## Static boundary and limits

ESLint rejects direct adapter imports. `architecture-boundaries.test.ts` uses TypeScript
resolution and realpaths to traverse first-party dependencies, including alias/relative/
barrel/static dynamic import/import-equals/type edges. It rejects Next/React/MCP SDK and
app/MCP/UI source imports, computed import()/require() edges, and engine → public edges.
In-memory negative fixtures use the same resolver, including .js-to-.ts resolution.

This is a bounded static graph audit, not a pure-domain or runtime security proof. Third-party
package internals, eval/generated code, custom module-loader aliases and arbitrary computed
module mechanisms beyond import()/require() are not analyzed. The existing engine Web Request
parser and host environment injection are deliberately retained. Synthetic builders do not
prove real provider economics; existing engine suites supply separate algorithm coverage.

## Delivery evidence

Workspace report: `output/sofinance-prepare-usecases-implementation-20261027-r1.md` and its
matching evidence folder. Commands record exact HEAD, dirty status, source hashes, arguments,
allowlisted environment, logs and cleanup. Fresh final checks cover focused tests, app/engine/
E2E types, lint, full two-lane environment matrix, RWA build, new Next build, 66 hermetic E2E
cases with retries0, built HTTP probes and a real SDK subprocess. Reused PG/container/pack
receipts require fresh dependency/closure identity; skipped PG tests are never passes.

Handoff is clean local commits for independent root review. No push/PR/merge/deployment.
STATIC and BEHAVIORAL claims are scoped local; FINANCIAL NOT_EXERCISED.

PR154 subsequently merged as `5150cdf60d9be719c553b05b241df30dd8d932a6` after CI and strict review.
Root's separate `output/sofinance-prepare-production-verification-20261027-r1.md` records
deployment `dpl_HMvswA5Mguo11dq9qouEY4dRKv8w`, 9/9 read-only checks with zero retries/skips,
and full 16-tool metadata parity. This is accepted-base evidence, not selected-submit proof.
