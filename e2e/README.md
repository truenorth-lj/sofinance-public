# SoFinance browser E2E (isolated package)

Playwright + an in-house **Wallet Standard fake wallet**. This directory is its own package: own `package.json`, own
`package-lock.json` (npm), own `tsconfig.json`. It adds nothing to the app's dependencies or the root pnpm lockfile and is
excluded from the root `tsc`, ESLint and Vitest.

```
fake-wallet/inpage.js      Wallet Standard wallet injected before any app script (holds only the PUBLIC key)
fake-wallet/node-signer.ts signing + adversarial modes + ledger, runs in the Node test process (the key never enters the page)
fake-wallet/install.ts     installFakeWallet(context, wallet)
pages/                     page objects (ConnectModal works for AppKit and wallet-adapter; SignPage mocks the broadcast routes)
support/                   sign-token minting (same algorithm as src/lib/pending-sign-token.ts), synthetic transactions, guards
tests/hermetic/            connect, signing, confirmation, recovery and cleanup flows (PR lane, no spend)
tests/prod/                read-only smoke against a deployed site (no signing, no broadcast, no server-side prepare)
scripts/                   build-app + serve-app (production build + next start with dummy config), repeat (flake check), mutation-check
../.github/workflows/ci.yml production build + hermetic E2E job
```

## Run

```bash
cd e2e && npm ci && npx playwright install chromium
npm run build:app         # production build with the same dummy configuration
npm run test:hermetic     # builds the app (dummy Reown id + dummy signing secret), `next start` on :3217, runs every hermetic journey
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

## Production readonly browser boundary

`prod-readonly` has **zero retries** and installs `support/readonly-policy.ts` before any page/app script.
It uses a fresh `serviceWorkers: "block"` context. It aborts intercepted non-origin HTTP(S) requests (including
future provider hosts, beacons and popup navigation), with no external static-resource exception. Every page
WebSocket is closed without `connectToServer`. Because worker sockets are outside Playwright's page socket
routing, fetched responses and synthetic wallet/token stub responses add an enforcing `worker-src 'none'` CSP: dedicated/shared workers, including
blob workers, cannot start. This lane does not exercise workers or WalletConnect pairing.

The same-origin scope is explicit, not a blanket permission:

- GET the five smoke pages, their listed public navigation/prefetch destinations, `/_next/static/` assets and favicon.
- GET `/api/rwa-pairs`, `/api/sol-usdc-price`, `/api/pool-range-apr`, `/api/pool-daily-apr`.
- POST `/api/verify-sign-token` only with the two fixed malformed tokens (expected HTTP400).
- Wallet scan GET and token-metadata POST retain their disclosed synthetic empty stubs; no balance/RPC success is fabricated.
- `/lumen` telemetry is aborted. Other operations, including unknown APIs, prepare, quote, sign/broadcast,
  status/provider proxies and browser MCP requests, abort **and fail** the scope audit. The existing open-status
  stub is deliberately unreachable in this lane.

Allowed requests use `route.fetch({ maxRedirects: 0, maxRetries: 0 })` and fulfill the single response.
**All redirects fail closed**, even same-origin redirects: use canonical smoke URLs. This avoids `continue()`
following an unchecked redirect chain. Install local route fixtures before the policy; do not add overriding
page/context routes afterwards. The helper owns wallet-stub ordering. These are trusted test-harness rules,
not a security boundary against malicious test code or a browser-process firewall.

The production tests and loopback fixture regressions share `support/readonly-fixture.ts`.
The fixture calls `policy.close()` before the final audit: it marks shutdown before closing pages,
uses the same unique cancellation reason for pages and context, keeps guards installed, and waits
for the policy's own pending callbacks. An allowed response acquired across shutdown is disposed
without a late `fulfill`; redirects are still checked and reported first. Disposal failures still fail
the audit unless they carry this owner's exact cancellation reason. A cancellation is recorded once.
This does not track arbitrary downstream handlers invoked through `fallback()`. Only a surfaced error carrying
that exact shutdown reason is classified as expected cancellation; other HTTP/WS callback errors fail the audit. Playwright
itself suppresses some underlying WebSocket close rejections, so this is not a complete protocol-error log.
Do not replace owning teardown with raw `context.close()` or `unrouteAll({ behavior: "ignoreErrors" })`.

Each browser test attaches a sanitized decision ledger: action, scope, hostname, HTTP method and resource type;
no URL paths, query strings, application IDs, headers or bodies. The separate `unhandled` observations add
only a local ordinal and whether the request event arrived during running or closing, with outcome `unknown`.
`blocked` means the handler selected abort before forwarding (the SDK can suppress target-close errors);
`forwarded` means the helper invoked one permitted same-origin transport hop, not proof of a successful response.
`cancelled` means this owner cancelled response delivery or interrupted its callback, not that the server
never received the earlier request. A success response before shutdown still reaches the page normally.
Forbidden responses and unhandled forbidden requests fail teardown; an unhandled request's transport outcome
is unknown. Trace status `-1` alone is never blocked proof. CSP-blocked worker attempts and native browser
background traffic are not represented as HTTP route events. During navigation or teardown, a pagehide beacon
may be accepted by the browser yet disappear before Playwright emits a request or invokes the handler. Thus
an empty ledger does not prove there was no attempt, and `sendBeacon(true)` does not prove transport completed.
Pinned Playwright 1.64 skips HTTP route handlers once `page.close()` was called or context closing started.
A request event can therefore have no matching handler even with these guards installed. Such an entry
remains **UNKNOWN and fails the audit after owning close**; neither `requestfailed`, status -1 nor a zero
loopback sink count upgrades it to `blocked`. The production PR167 failure is not declared fixed in full:
late delivery is narrowed here, while the skipped-handler closure case remains a revalidation blocker.
The loopback tests use actual server request and
WebSocket-upgrade counts, plus intentional guard-disable/bypass controls, to verify prevention.

`APIRequestContext` does **not** pass browser routing. The two direct MCP actions remain explicitly public
`tools/list` and unauthenticated `list_rwa_pairs` rejection (401 before dispatch), with redirects/retries disabled.
They do not execute authenticated tools. Allowed public pages/APIs can perform server-side provider reads;
this browser policy does not prove zero server-side provider activity or financial correctness.

```bash
npm run test:policy       # own loopback origins/sinks, real Chromium; no app or production webServer
```

CI runs this narrow policy lane before the existing hermetic flows; it never runs prod-readonly on production.
For offline local nine-journey verification, use a fresh app build (or a precisely identified reused build
whose application/build inputs are unchanged) and disclosed loopback fixtures for the four
public data reads, retaining the real AppKit modal, malformed-token route, MCP routes and empty signing ledger.
Local evidence does not resolve the PR166 production provider-read scope exception; corrected-harness production
revalidation remains a separate root-owned step.
