# Fix open-position submission and confirmation

Branch: `dev/fix-open-confirmation`. Date: 2026-10-13. Scope authorized: fix the two P1 findings, test, open a PR.

## Requirements

- Before send failures and explicit RPC preflight rejection may report `sent:false`. Network/mismatched-signature errors after send remain unknown.
- Persist the signed open attempt before broadcast, preserving prior records. Include wallet, signature, NFT mint, pool, expected position/range/liquidity and blockhash expiry. Storage failure prevents broadcast.
- A returned signature means pending. Only finalized success plus verification of the expected position may display Position opened.
- Restore and reconcile on reload/remount. Pending/unknown or invalid records prevent a second open attempt; explicit unsent, failed or expired transactions can be retried without losing the previous signature.
- Ignore stale wallet/pool/input responses and signing results. Preserve NFT partial signatures and existing permit/simulation/packet checks.

## Acceptance

- RPC receives a transaction but the response is lost: UI retains its original signature, stays pending, and does not prepare a new transaction.
- A transaction is accepted, then fails on-chain: UI reports failure, never Position opened.
- Reload with an unresolved record: query the original signature without signing/broadcasting again.
- Finalized success with matching NFT/pool/position: display Position opened; incompatible account facts require manual review.
- Explicit preflight rejection: show unsent and permit retry. Signature mismatch, timeout, or rate limit do not make that claim.
- Wallet/selection changes during prepare/sign prevent stale broadcast. Local storage failures prevent broadcast.

## Validation

Service, HTTP/MCP, persistence, status route and controller regression tests; lint/typecheck/full unit suite; build and hermetic browser open-position flow with unfunded throwaway keys and mocked broadcast.
