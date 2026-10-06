# Transaction status dialog

**Branch:** `dev/transaction-status-dialog`  
**Created:** 2026-09-30

## User scenarios

### P1 — Show a signed transaction's result

Given the wallet returns a signature, when the app records the attempt, then a dialog opens with the full transaction hash and a link to the explorer. It shows confirmation in progress until the existing chain reconciliation reports success, failure, expiry, or manual review.

### P1 — Preserve uncertain states

Given broadcasting or status lookup fails, when the chain result remains unknown, then the dialog must not claim success or failure. It keeps the hash visible, explains that the result needs checking, and prevents another deposit while the attempt is unresolved.

### P2 — Recover after closing or reloading

Given an attempt exists in local storage, when the page reloads or the user closes the dialog, then a pending attempt opens the dialog again after reload and every recorded attempt can be reopened from the page. A prior terminal attempt does not interrupt the page on reload.

## Requirements

- Keep the existing transaction creation, signing, broadcast, and chain status rules.
- Use the existing `pending`, `success`, `failed`, `expired`, and `manual-review` states; only `success` may say the deposit is confirmed.
- Show a clickable full transaction signature in every attempt state.
- Allow closing the dialog without cancelling or resubmitting the transaction.
- Keep the dialog usable on mobile and accessible through keyboard focus and Escape.

## Success criteria

- The dialog opens when a new signed attempt is recorded and updates as reconciliation changes its status.
- A pending attempt remains visibly unresolved when RPC or broadcast checks fail.
- Automated checks cover status labels, explorer link, and terminal versus uncertain states.
