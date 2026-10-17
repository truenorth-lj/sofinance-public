# Compound account cleanup

Created: 2026-10-17. Branch: `dev/compound-account-cleanup`.

## Behavior

- After a compound initiated in the current browser session has finalized and its full yield receipt is verified, automatically prepare a separate recovery transaction. The wallet approves this second transaction to consolidate remaining yield into its associated token accounts and close the isolated sources.
- A declined or failed cleanup preserves the successful compound and its recoverable receipt. Reloading or reconnecting never starts a new signature prompt automatically.
- A wallet-wide scan finds historical compound accounts, including zero-token sources, closed positions, and records absent from browser storage. Only original, finalized, verified compound receipts are eligible; arbitrary non-ATA assets and NFT accounts are excluded.
- One cleanup action processes the discovered receipt groups sequentially. Each transaction is freshly prepared, simulated, wallet-signed, persisted before broadcast, and independently verified. Stop on rejection, unknown/pending results, failed proof, identity change, or unmount.

## Constraints

Use the existing engine's recovery builder, permit, size checks, owner/mint/seed/close-authority checks, exact destination-credit verification, and source-closure verification. Never burn assets, spend existing principal, sign on the server, or broadcast in tests.

An atomic dynamic sweep cannot be expressed using SPL's fixed-amount transfers, and captured compounds already approach Solana's 1,232-byte packet limit. Cleanup therefore follows successful compound in a second wallet-approved transaction. It is not part of compound success/failure.

Discovery reads both token programs and pages current non-ATA accounts and their finalized histories. RPC failures, exhausted proof budgets, and unfinished pagination must never be presented as a clean wallet. Current source state is checked again at preparation and broadcast; discovery is not authorization to spend.

## Acceptance checks

1. A verified new compound initiates cleanup once; a restored compound never prompts automatically.
2. Leftovers reach the wallet ATA without consuming existing holdings; source accounts close and rent returns to the wallet.
3. Zero-balance sources close without creating unnecessary destination ATAs; a previously closed pair leg is skipped.
4. Historical discovery works without a selected/live LP NFT or local receipts, deduplicates paired sources, and continues bounded history pages.
5. Rejection, partial scans, missing proof, changed source balances, unknown broadcast results, and identity changes stop safely and preserve recovery evidence.
6. Tests, typecheck, lint, production build, and independent review pass. Delivery stops at an open PR for owner review; no merge or deployment.
