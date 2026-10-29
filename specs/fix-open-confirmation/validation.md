# Open-position fix validation

Base: `a8421e2`, fetched from `origin/main` on 2026-10-13 before development and verified again before PR delivery.

## Local checks

- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm test`: 185 test files and 1,624 tests passed.
- `cd e2e && npm run typecheck`: passed.
- Next.js webpack production build: passed using the E2E harness's dummy AppKit/Jupiter configuration.
- Playwright J2, J3 and J7 on that build: 28 passed, one worker, zero retries.

Commands for browser verification:

```bash
E2E_PORT=3230 node e2e/scripts/serve-app.mjs
cd e2e
BASE_URL=http://localhost:3230 node node_modules/@playwright/test/cli.js test \
  --project=hermetic tests/hermetic/j2-sign-happy.e2e.ts \
  tests/hermetic/j3-sign-negatives.e2e.ts tests/hermetic/j7-open-confirmation.e2e.ts \
  --workers=1 --retries=0
```

The browser harness uses unfunded, throwaway Wallet Standard keys. Broadcast and open-status APIs are mocked, including the sign-link tests. No live transaction is sent. Local runtime: Node 24.19.0; repository CI uses Node 22.

## Regression coverage

- Service, HTTP and MCP: explicit RPC preflight rejection is unsent; network/RPC/signature mismatch after submission remains unknown.
- Persistence: record saved before broadcast, previous record archived, corrupt/foreign records rejected, silent storage failures prevent broadcast, definite unsent records archived before unlocking.
- Status endpoint: waits for finalized status, verifies original wallet/NFT signers, blockhash, CLMM open instruction, derived position PDA, pool, ticks and liquidity. Missing history with a surviving position requires manual review.
- Controller: acceptance remains pending, reload restores original signature without another sign/prepare, failed/expired results permit retry, unknown RPC result stays blocked, late wallet/selection/unmount results cannot broadcast.
- Browser: pending UI and original explorer link survive reload/reconnect; only verified completion displays Position opened; finalized failure allows another preparation. Sign-link success and negative message/partial-signature guards remain intact.

## Limits

These are local mocked-chain checks and a built-app browser run. They do not prove mainnet execution, provider availability or deployment. Manual-review deliberately retains the original attempt and blocks another open when the chain facts cannot be reconciled.
