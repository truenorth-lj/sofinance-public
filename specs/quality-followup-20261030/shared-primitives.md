# Shared recovery primitives decision

Reviewed after SOL #243, RHC #244, Compound #245 and Meteora #246 on main
`ed936bb8edeaef2cd90e34cb06ce560ccfab17ec`.

## Decision

Keep transaction-specific persistence and lifecycle controllers explicit. Reuse
the existing wallet-returned transaction guard, extra-signer helper and owned
secret disposal (Meteora now does so). No new universal transaction controller
or storage policy is needed for this delivery.

The repeated low-level work is string comparison plus storage write/readback.
Extracting only those few statements would leave the ownership and ordering
rules at each caller; a generic callback/configuration layer would hide the rules
that the four recent recovery batches were written to enforce. The worthwhile
shared contract is currently the behavioral acceptance checklist below, not a
new state-machine abstraction.

| Flow and source | Policy that remains local |
| --- | --- |
| SOL `src/components/transactions/open/sol-swap-attempt-store.ts` | Signature known before send; durable delivered-amount receipt before clearing swap attempt; retain any step-2 signature. |
| RHC `src/lib/rhc-wallet/open-attempt.ts` | Intent saved before provider send; hash may never be returned; wallet/chain recheck and NFT receipt matching; no invented expiry. |
| Compound `packages/engine/src/compound-attempt.ts` and controller | Archive prior attempts; preserve multiple recovery-account receipts; prune matching receipts and synchronously revoke live batch admission on readback failure. |
| Meteora `src/lib/meteora-wallet/pending.ts` and panel | Setup/deposit/close transitions, position signer ownership, wallet-scoped legacy migration and conflict preservation. |

A shared React ownership hook is also premature: form revision, committed
callbacks, batch admission and reconciliation have different revocation points.
Keep those checks adjacent to the prepare/sign/persist/send effects. Engine
storage has no React/browser dependency; avoid adding one via an app helper.

## Shared acceptance checklist

- Persist enough public information to reconcile before external submission;
  verify write/readback before continuing.
- Preserve unknown outcomes, malformed storage and conflicting records.
- Check live operation ownership after deferred work and before signing/sending.
- Reconcile the original transaction without automatic signing or resend.
- Mutate only the expected record; never equate comparison with atomic cross-tab locking.
- Cover healthy controls, storage errors, delayed callbacks and remount recovery.

Existing regression tests exercise these rules in each real controller/storage
path. Future extraction should demonstrate reduced duplication at multiple
callers while preserving those tests and operation ordering; it is not required
to declare the current behavior fixes complete.
