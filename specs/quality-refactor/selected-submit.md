# Selected submit shared RPC stage (PR4)

Accepted base: PR154 squash `5150cdf60d9be719c553b05b241df30dd8d932a6`.
Implementation is local only; independent review, CI and production delivery remain pending.
Workspace report: `output/sofinance-selected-submit-implementation-20261027-r1.md`.

`src/server/transactions/selected-submit.ts` owns connection, parallel confirmed height/state
reads, invariants, same-message simulation, final expiry, original signed bytes send, expected
signature comparison and history invalidation. Its typed internal command contains the same
transaction instance, wallet/signature and permit-bound facts. Types do not prove authorization.
There is no transaction reconstruction, new permit, blockhash refresh, retry wrapper, deadline,
error catch, persisted attempt ledger or new MCP outcome.

HTTP retains raw parsing/on-curve checks, structure and size before permit, then local nacl.
MCP retains dispatcher schema then wallet binding, positive amount/expiry, deserialization,
permit before structure, and no extra local nacl. Both always simulate with sigVerify:true.
The two named application profiles preserve exact state-reader arguments, HTTP displayPrices:false,
HTTP early native WSOL rejection, HTTP useStateSnapshot:true versus MCP additional reads, and
both original state-change and signature-mismatch error strings. Request data cannot select flags.

Both adapters own their original response/error projection and Beam mapping. Invalidation stays
after matching accepted signature and before Beam. Once a physical send starts, an exception
remains unknown: no sent:false or safe-to-retry inference. Existing callers retain their original
signature; this extraction does not add server persistence or idempotency. Duplicate calls can
still send identical bytes twice. Other operation senders, all engine algorithms, prepare/quote,
controllers, attempt persistence and storage are outside this change.

## Frozen characterization and local gates

Checkpoint `b9f2efbf33e81c27c9d28be35d0ab927f045150d` adds only tests/snapshots on the
accepted runtime, before migration: 155 tests and 152 complete response/I/O-trace snapshots.
Real App HTTP, HTTP MCP and in-process registered SDK use actual tools, real HMAC/transaction
validation, real selected simulator and (for timeout then retry rejection) real engine RPC
wrapper. Only backend state/RPC/cache/Beam I/O is controlled by disposable fixtures. Synthetic
signed transactions never reach a network. Tests record exact bytes, send options/count/order,
read arguments, extra account/balance reads and invalidation ordering.

Cases include structure+permit precedence, malformed fields/wallet/signatures/size, modified
permit-bound facts, BigInt precision, state/NFT/WSOL changes, expiry, simulation failures,
unknown sends, signature mismatch, accepted then Beam failure, concurrent wallets/positions,
duplicate submissions, HTTP cancellation and async context. Existing complete authenticated
prepare/sign-token/HTTP-submit roundtrip and compression-normalized goldens remain unchanged.
Fresh local gates include focused checks, lint, app/engine/E2E types, both environment lanes,
RWA build, a fresh Next build with hermetic E2E retry0, built HTTP and real SDK child probes.
The child only exercises discovery/early rejection; in-process mocks do not cross a child.

The existing bounded dependency graph guard automatically includes the new module. Root PR154
negative controls for library-to-usecase and engine-outside-package edges remain unchanged.
Static graphs do not prove runtime authorization. Any reused PG/container/pack evidence needs
exact dependency and closure equality, recorded separately from fresh selected-submit tests.
STATIC/BEHAVIORAL conclusions are local and scoped; FINANCIAL NOT_EXERCISED.
