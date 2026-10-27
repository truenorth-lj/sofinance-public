# Withdraw checkpoint safety (D2)

Local implementation on accepted D1 merge `8a8d013000b352031efa5e323723f43368ff2295`. Independent review and delivery remain pending. D3 lifetime/wallet/ABA/expiry/response-identity changes and broad controller decomposition are separate.

`WithdrawPanel` previously treated JSON/read errors as no history and broadcast after a silently dropped write. The mounted-panel regression suite reproduces both on the accepted implementation with synthetic prepared transactions and disposable signatures.

## Storage contract

`src/lib/withdraw-checkpoint.ts` owns only the existing `sofinance:withdraw:${wallet}:${positionMint}` key and unversioned JSON shape: complete `prepared`, `signature`, original `request`, `confirmHighImpact`, and optional `root` with the first prepared object/signature. There is no migration, server/API change, or deletion of malformed data.

Reads distinguish actual absent key from valid, invalid and unavailable history. The validator checks the complete builder-shaped summary, request forms, nested values, decodable transaction bytes, signature/address shape, wallet/position association and the swap's required first root. Atomic/first-withdraw checkpoints may omit root; swap checkpoints must contain the original first prepared object/signature, matching the historical panel writer. A rootless swap is retained as invalid history, never reconciled into an empty record or fresh principal retry. Expired complete checkpoints remain valid for status reconciliation. It returns the original parsed object, preserving optional/unknown fields, permits and unsigned bytes; schema outputs are never used as reconstructed checkpoints. Shape checks do not authenticate a permit/signature or verify financial execution.

Every write/remove checks the current valid bytes against the previously observed bytes, performs the mutation, then checks the exact stored bytes (or actual absence). Only verified success publishes a new in-memory checkpoint. Exceptions, dropped mutations, changed bytes and readback failures stop the runner, retain the last verified in-memory checkpoint, and leave durable evidence as observed. There is no compensating rollback or automatic deletion. A write may have succeeded despite a readback error; reload can recover it. This read/check/write/read fence is not atomic cross-tab compare-and-swap.

## Intentional behavior changes

Invalid/unavailable history and uncertain mutations now show a storage/history error and block preview, signing, Resume, Retry and dialog confirmation until reload. The form, Close and parent busy state treat this history as unresolved, like an existing checkpoint. A normal healthy checkpoint and healthy new operation retain existing busy coordination. Parent effect cleanup still reports false; it is not a D3 lifetime fix.

Storage is rechecked on action entry, after async preparation/quote/status, before wallet prompting and before all mutations. A panel mounted with healthy history cannot later overwrite or clear newly invalid or changed bytes at these boundaries. The UI does not automatically adopt another tab's changed checkpoint.

Pending/manual-review/network outcomes retain the original signature/checkpoint. Atomic/first terminal failure or expiry clears only after verified removal. Swap failure/expiry restores the full first root only after verified write; later Resume checks S1 and prepares only conversion. First finality still notifies history with S1 before conversion (even if preparation or signing fails). Swap finality refreshes history without using S2 as the position-history signature. Completion/onConfirmed occurs only after verified removal. Notification of observed finality can precede a removal error; it is not a successful completion claim.

## Local verification scope

- Mounted React panel: malformed JSON/primitives/arrays/nested structures and identity mismatch; unavailable storage; set/remove throw, silent drop and readback failures; mid-action history changes; atomic persist/readback/send/status/clear; unknown send/remount; two-stage root preservation/recovery; high-impact cancel/confirm; original request/first prepared retention; pending/manual-review/network; retry and parent busy behavior.
- Helper compatibility: complete optional fields, unchanged raw and unknown fields, historical request forms, actual builder outputs for atomic/original/token/target/sponsored/first/swap-root using the existing disposable builder/RPC fixture.
- Validation receipts and RED/GREEN event ledgers live in the workspace output report, outside the product repository. Full environment matrix, lint/types and fresh production-build hermetic browser gates are required for handoff.

All wallet signatures, permits, RPC receipts and transaction operations in these tests are synthetic/local. FINANCIAL NOT_EXERCISED; local behavioral proof is not release or production proof. No automatic resend, server protocol tightening, new wallet support, or cross-tab lock is claimed.
