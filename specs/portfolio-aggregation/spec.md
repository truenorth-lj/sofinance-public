# Portfolio aggregation

Approved direction: one aggregate read for Portfolio figures, with bounded backend concurrency, shared account/price/metadata reads and per-position failure isolation. Existing wallet discovery remains shared with transaction controllers; EVM discovery keeps its current chain binding.

- Given the wallet's discovered open Solana positions, one Portfolio request returns compact per-position figures and totals. Detail reports load only when opened.
- Values, stock-equivalent shares and fees match the existing valuation math. Incomplete history never presents cumulative fees as complete. Missing values remain null and totals identify partial coverage.
- Account reads and token prices are deduplicated within a request. History synchronization keeps lease fencing, parser/version checks, cancellation and finalized transaction refresh markers.
- Two position workers bound upstream work; a failed or timed-out position leaves other results usable. Request size and source admission are validated before I/O.
- Wallet changes, disconnects, refreshes and confirmed operations cannot publish an older request's results into a newer view. No financial submission or policy changes.
- Regression checks cover numeric parity, partial history, batch requests, failures, request budgets and refresh races. Verify the deployed revision and compare the same five positions with the baseline.
