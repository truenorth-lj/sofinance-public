# Transaction recovery and quality follow-up

Base: `3ab55afa411597861db60b1cf5a9bf2fa8f76f28`. LJ authorized completing the
2026-10-30 review findings in order, including tested/reviewed delivery.

## Delivery order

1. SOL step-1 durable pending signature and unknown-broadcast recovery.
2. RHC pending transaction persistence, unknown outcomes and lifecycle ownership.
3. Compound receipt readback, synchronous admission revocation and batch fences.
4. Meteora durable attempts and wallet/lifecycle ownership before production signing.
5. Review common persistence/ownership primitives after behavior is covered; keep
   protocol-specific transaction semantics explicit.
6. Store response contracts, remaining opens-log migrations, orphan snapshots and
   stale tracking/flag documentation.

Each batch has its own focused PR, relevant local tests, review, CI and deployed
identity verification. Existing unknown/failed evidence is retained. Financial
flows are not exercised by these synthetic tests.

## SOL user scenarios (first batch)

- Given a signed step-1 swap, when storage write/readback fails, no broadcast occurs.
- Given a durable step-1 signature, when HTTP fails or returns invalid JSON, the
  app checks that exact signature without asking the wallet to sign again.
- Given an unconfirmed swap, when the modal reloads, wallet changes, or the pool
  changes, the original wallet's pending attempt remains; new opens are blocked
  until it is checked. Requery is read-only and never opens step 2 automatically.
- Given a confirmed swap, persist the existing step-2 receipt before removing the
  pending attempt. Preserve newer records and an already tracked step-2 signature.
- Given an explicit pre-broadcast rejection or chain-confirmed failed/expired
  outcome, remove only the matching pending attempt after verified persistence.

## Constraints and edge cases

No transaction/fee calculation, flag activation, secret storage, automatic resend,
or destructive migration. Pending attempts have no browser-clock expiry; only the
chain can settle them. Malformed/unreadable storage fails closed. The new
wallet-scoped pending key does not change legacy landed-receipt compatibility.
Storage compare/readback detects changed snapshots; it is not a cross-tab atomic
CAS guarantee. Reconciliation must never replace a newer transaction record.

## Success criteria

Original lost-response probes pass with healthy and explicit-unsent controls;
new reload, storage-failure, stale-ownership and receipt-handoff cases pass.
Repository lint/typecheck, relevant tests and hosted CI pass. Each completed phase
records its commit/PR and distinguishes local, hosted and deployment evidence.
