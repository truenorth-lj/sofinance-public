# Unified open-position screenshots

Local `next dev` + hermetic Playwright route fulfillment (same pair-list
fixtures as the e2e-hermetic lane: `e2e/support/fixtures/rwa-pairs.json`,
`protocol-pools-rhc.json`). APR figures in the Raydium and Meteora shots
are not taken from those pair-list fixtures.

All three Create-position modals were captured with a connected mocked
wallet (Solana Wallet Standard “E2E Wallet” for Raydium and Meteora;
injected MetaMask on Robinhood Chain 4663 for RHC). Terms acceptance was
pre-seeded so the form — not a connect-only prompt — is what you see.

Captured 10 Nov 2026, Asia/Taipei.

## Data source per shot

- `raydium-tslax-tsla-card-1280.png`, `raydium-tslax-tsla-card-375.png`,
  `raydium-open-modal-1280.png`, `raydium-open-modal-375.png`,
  `raydium-open-modal-button-375.png`: live production
  `GET https://sofinancelab.xyz/api/pool-range-apr?poolId=4bMbJzxWyiokwyQC4ndST5sJv6Qnb4viyACzhyFUgRbd`
  (Raydium TSLAx/TSLA). Snapshot taken 10 Nov 2026. After the shared
  $1,000 preview reprice and fee cap: Best = Standard ~4.3% (the card
  prints 4.35%); other ranges Micro ~4.2%, Tight ~3.9%, Wide ~1.9%.
  `raydium-open-modal-button-375.png` is the 375 view scrolled to the
  Create position button.

- `meteora-open-modal-1280.png`, `meteora-open-modal-375.png`: live
  production
  `GET https://sofinancelab.xyz/api/pool-range-apr?poolId=8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh`
  (Meteora TSLAx/TSLA, `protocol: meteora-dlmm`; read-only). Snapshot
  taken 10 Nov 2026. After the $1,000 preview reprice and fee cap: Best
  resolves to Tight ~44%; the dialog defaults to Standard, so the
  headline is ~17%; other ranges Tight ~44%, Micro ~41%, Wide — (this
  range spans 200 bins; one position holds at most 70). Scrolled so the
  costs box and the Create position button are visible.

- `rhc-open-modal-1280.png`, `rhc-open-modal-375.png`: the dialog does
  not call `/api/pool-range-apr`. The APR panel shows “—” and “7-day
  estimate is shown on the pool card.” Pool chrome comes from
  `e2e/support/fixtures/protocol-pools-rhc.json`.
