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
(appends a Lighthouse-style instruction as Phantom/Solflare do; HTTP flows accept that extra ix, MCP `/app/sign` still requires a byte-identical message), `no-signature` (returns an unsigned tx), `slow`.
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

The production fixture establishes a **deny-only browser proxy before context creation** via
Playwright's public `proxy` option. The local proxy responds to HTTP, CONNECT and upgrade requests
without ever dialing, resolving or tunnelling to a destination. It has no forward/allow path.
Pinned Chromium also proxies loopback (the installed SDK sets `<-loopback>`). The proxy remains
configured through teardown; closure cannot turn it into a direct connection. HTTP(S) and WS(S)
transport controls remove all route handlers to verify this independent boundary, and disable the
proxy to prove the same sinks are reachable. Normal app execution stays online. Only Chromium
is validated and accepted by this helper; this is not an OS, DNS, UDP, WebRTC or WebTransport sandbox.

Allowed requests use a **separate APIRequestContext**, `fetch(request, { maxRedirects: 0,
maxRetries: 0, headers })`, and fulfill the single response. The browser request's full headers,
method and body are retained. An explicit Cookie header (empty when absent) prevents the API
client's jar from injecting cookies absent from the browser; browser `Set-Cookie` behavior still
comes from fulfillment. **All redirects fail closed**, even same-origin redirects. The forwarding
client never uses the deny proxy; the browser context's own `context.request` does inherit it.
The two fixed direct MCP tests use a separate unproxied request fixture. Neither client is covered
by the browser transport guarantee. Public-read forwarding still permits server-side provider reads.

The production tests and loopback fixture regressions share `support/readonly-fixture.ts`.
`support/readonly-transport.ts` owns the proxy and forwarding client. Standalone policy controls
use `createReadonlyContext`; installing only `installReadonlyPolicy` on a raw context retains
legacy **route-only** behavior and cannot claim proxy containment. Registering a transport on a
context without its actual proxy, overriding fixture wiring, or changing routes after installation
violates the trusted harness contract. This is not a boundary against malicious test code.

`policy.close()` starts cancellation before closing any page, gives pages/context a unique owner
reason, closes the independent client with that same reason, and drains its callbacks. New public
forwarding is refused once shutdown starts. Both readonly wallet stubs fulfill inside that tracked
handler (no downstream `fallback`); ordinary hermetic stubs are unchanged. An allowed response
acquired across shutdown is disposed without a late fulfill; a received redirect still fails.
Generic fulfill/disposal failures and foreign cancellation reasons remain failures. An already
entered fulfill is not retroactively erased. Double/concurrent close returns one shared promise;
page crashes, early/foreign page or context close, and surfaced close/dispose errors fail the audit.
The actual fixture attaches the ledger in a nested finally even when owning close rejects.

Each browser test attaches sanitized decisions (action, scope, hostname, method, resource),
`unhandled` observations (local ordinal, running/closing phase, outcome), and a transport audit
(guarantee, denial counters, failures). No paths, queries, bodies, headers, credentials or app IDs
are retained in this ledger. `blocked` records an abort decision, not guaranteed SDK completion;
`forwarded` records an allowed single-hop invocation, not a successful response. `cancelled`
records owned callback/delivery cancellation or refusal of new forwarding during shutdown, not
proof that an earlier request never reached the server.

Pinned Playwright 1.64 can skip a handler once page/context closing starts. **Such a request stays
`outcome: unknown`**, including after close. A managed context additionally records
`containment: deny-only-browser-proxy`: independently of exact request delivery/cancellation, the
browser has no destination-forwarding path through that proxy. After successful owning closure,
this independently established containment permits external/telemetry unknown observations without
forging blocked decisions. Forbidden attempts still fail even if their handler was skipped.
Active-run handler bypass responses/terminal events remain permanent failures, as do generic errors
and unexpected lifecycle events. Raw route-only contexts still fail every unhandled unknown.

An offline-before-close candidate was **rejected**: despite acknowledged `setOffline(true)`,
late same-origin keepalive requests whose handlers were skipped reached loopback telemetry and
forbidden sinks. Offline state, `requestfailed`, status -1, `sendBeacon(true)`, an empty sink or a
timeout never upgrades unknown to blocked. Whole-test offline mode is not used. The earlier PR166
getBalance UNKNOWN and PR167 production failure remain immutable historical results.

Limits retained: a pagehide beacon may disappear before any SDK observation, so the ledger is not
an exhaustive attempt list (QA-L1). Playwright suppresses some low-level WS close rejections;
only surfaced errors can be audited (SEC-L1). Worker CSP, `serviceWorkers:block`, and page WS
no-connect guards remain in force. Proxy containment covers browser HTTP(S)/WS(S) under the pinned
trusted configuration, not every native/browser protocol or API/server transport.

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
