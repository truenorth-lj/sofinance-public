# Position withdrawals

POST `withdraw-quote` with wallet, positionMint, percent (1–100, up to two decimal
places) OR targetUSDC. Receive defaults to `usdc`; `token` needs outputMint (SOL
or a pool token); `original` preserves tokens and charges no conversion fee.
Target USDC is an estimate of principal using current display prices; it excludes
accrued fees and does not promise an exact dollar payout.

`withdraw-prepare` fully simulates and returns {summary, unsignedTransaction,
permit}. Sign the exact message with the owning wallet, then send those fields
plus wallet and signedTransaction to `withdraw-broadcast`. Impact above 200 bps
warns; above 500 bps requires confirmHighImpact=true at prepare and broadcast.
The default slippage and configured swap fee reuse the existing swap helpers.
Rent from closing the position/NFT accounts is returned in SOL, never converted
or charged a protocol fee. Full withdrawal closes the position and burns its NFT.
Decrease collects accrued fees and rewards, including on partial withdrawal.

Atomic conversions reuse compound's fresh seeded source accounts: decrease credits
those accounts directly, and Jupiter's exact source keys are retargeted. A source
must start absent and close empty after conversion. A changed received amount
fails closed rather than spending prior wallet holdings. This stricter atomic
check can require refreshing a preparation as pool activity changes.

Oversized conversions return stage=withdraw and transactions=2. After tx1
finalizes, call prepare with stage=swap, tx1Signature, previous (the complete
prepared tx1 result), and the original request. The server verifies the exact
finalized message and token balance deltas, caps each conversion at the smaller of the finalized receipt and earlier
simulation amount (rejecting any receipt below its principal minimum), and requires unchanged wallet inventory. Excess received
remains in the wallet. The swap stage cannot use balances from another receipt.
If stage 2 cannot fit, the received tokens remain in the wallet; preparation
fails without sending. No server private wallet keys are used.

`withdraw-status` accepts {signature, prepared}, validates the permit, and reports
success only after finalization and a complete message match. UI checkpoints
persist before submission so an interrupted broadcast is reconciled before
another operation. MCP prepare_withdraw returns the existing compressed sign
link and submit_withdraw handles signed submissions; a two-stage sign link needs
a second prepare after tx1 finalizes.

Run `tsx scripts/live-fee-test.ts withdraw --position NFT --percent 100 --receive
usdc` for a dry-run (use `--receive token --mint M` or `original`). Only `--send`
enables broadcasting. The command reports signed bytes, system transfers, fees, recipient
balance deltas, and wallet SOL changes. A dry-run cannot prepare stage 2 without
a finalized stage 1. High-impact requests fail unless explicitly confirmed by a
client; the CLI intentionally does not automatically confirm them.
