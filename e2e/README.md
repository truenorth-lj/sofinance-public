# SoFinance browser E2E (isolated package)

Playwright + an in-house **Wallet Standard fake wallet**. This directory is its own package: own `package.json`, own
`package-lock.json` (npm), own `tsconfig.json`. It adds nothing to the app's dependencies or the two root lockfiles and is
excluded from the root `tsc`, ESLint and Vitest.

```
fake-wallet/inpage.js      Wallet Standard wallet injected before any app script (holds only the PUBLIC key)
fake-wallet/node-signer.ts signing + adversarial modes + ledger, runs in the Node test process (the key never enters the page)
fake-wallet/install.ts     installFakeWallet(context, wallet)
pages/                     page objects (ConnectModal works for AppKit and wallet-adapter; SignPage mocks the broadcast routes)
support/                   sign-token minting (same algorithm as src/lib/pending-sign-token.ts), synthetic transactions, guards
tests/hermetic/            J1 connect, J2 sign-link happy path, J3 sign-link negatives   (PR lane, no network, no spend)
tests/prod/                read-only smoke against a deployed site (no signing, no broadcast, no server-side prepare)
scripts/                   serve-app (build + next start with dummy config), repeat (flake check), mutation-check
ci-workflow.yml.example    non-blocking GitHub Actions job (copy to .github/workflows/e2e.yml)
```

## Run

```bash
cd e2e && npm ci && npx playwright install chromium
npm run test:hermetic     # builds the app (dummy Reown id + dummy signing secret), `next start` on :3217, runs J1-J3
npm run test:adapter      # same, but the wallet-adapter provider (no Reown id): J1 + J2 smoke
npm run test:prod         # read-only against https://sofinancelab.xyz (PROD_URL=... to override)
npm run repeat -- 5       # flake check: N fresh runs, retries off
node scripts/mutation-check.mjs   # break app guards one by one, expect the suite to fail (restores the files)
BASE_URL=http://localhost:3000 npx playwright test --project=hermetic   # reuse a running `next dev` / any server
```

Hermetic lane = **sign-only**: a random throwaway key per test, no funds, broadcast routes mocked, third-party hosts
(Reown, WalletConnect, Google Fonts) aborted, unexpected hosts / `pageerror` / `console.error` fail the test.
`/api/verify-sign-token` is the real server route; the server runs with a CI-only dummy signing secret
(`E2E_SIGNING_SECRET`, default `e2e-ci-only-not-a-secret`, exported to the server as `JUPITER_API_KEY`).

The provider variant is inlined at build time: `E2E_PROVIDER=appkit` (default, same as production) or `adapter`.

## Fake wallet modes (`wallet.mode`)

`normal`, `reject`, `mutate-message` (appends a Memo instruction), `tweak-bytes` (same-length change), `lighthouse`
(appends a Lighthouse-style instruction as Phantom/Solflare do), `no-signature` (returns an unsigned tx), `slow`.
The wallet is called "E2E Test Wallet" on purpose (AppKit maps well-known wallet names to special behaviour).

## Secrets

* The key lives in the Node process only (`FakeWallet` keeps it in a private field, hides it from `JSON.stringify`/`console.log`).
  The page gets the public key and two functions that call back into Node.
* Traces/screenshots therefore contain DOM + network only. The hermetic lane uses throwaway keys and dummy secrets anyway.
* **Never** put the funded test key into this lane. A future live lane needs `retries: 0`, one worker, an explicit
  `E2E_ALLOW_MAINNET=1`, a signing policy and an approval-gated environment (see the roadmap).

## Selectors

The app has no `data-testid`s; tests use roles and visible text. When the UI copy changes, update `pages/`.
