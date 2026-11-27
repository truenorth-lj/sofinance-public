# Deploying the web app on Railway

Production runs on Vercel today. This page is how the same `release` branch also runs on Railway, so the site can be
tested there before DNS moves. The app behaves the same on both. Nothing here changes Vercel.

| Railway service | Built from | What it does |
| --- | --- | --- |
| `web` | `railway/web.Dockerfile` | Next.js server (`next start`) on `0.0.0.0:$PORT` |
| `rwa-refresh-cron` | `railway/rwa-refresh-cron.Dockerfile` | Calls `/api/internal/rwa-refresh` on a schedule, then exits |
| `Postgres` | existing | RWA / history database (already serving production through `SOFINANCE_RWA_DATABASE_URL`) |

The repository-root `Dockerfile` is the separate RWA data service. Railway always builds a root `Dockerfile` when it
finds one, so every Railway service for this repo **must** set `RAILWAY_DOCKERFILE_PATH`.

Railway Config as Code (`railway.json`) cannot be used by new services, so service settings are listed here and set in
the dashboard. Moving them to Railway IaC (`.railway/railway.ts`) is a possible follow-up.

## Service settings

Put both services in the same Railway project as `Postgres`, region **Singapore (`asia-southeast1-eqsg3a`)**.

### `web`

| Setting | Value |
| --- | --- |
| Source | GitHub `truenorth-lj/sofinance-public`, branch `release` (same release model as Vercel), auto-deploy on |
| Region / replicas | Singapore, **1 replica** (rate limits and the ISR/data cache are per instance) |
| Variables | `RAILWAY_DOCKERFILE_PATH=railway/web.Dockerfile`, `PORT=8080`, plus the env checklist below |
| Healthcheck path | `/api/health` (liveness only: no database or RPC call), timeout 120 s |
| Restart policy | On failure, 10 retries |
| Serverless (sleep when idle) | Off |
| Networking | Generate a Railway domain on port 8080. Custom domains are added only at the DNS step |
| Pre-deploy command | None. Database migrations stay manual (`pnpm db:migrate`, see `db/README.md`) |

### `rwa-refresh-cron`

| Setting | Value |
| --- | --- |
| Source | Same repo, branch `release` |
| Region | Singapore |
| Variables | `RAILWAY_DOCKERFILE_PATH=railway/rwa-refresh-cron.Dockerfile`, `CRON_SECRET=${{web.CRON_SECRET}}`, `SOFINANCE_RWA_REFRESH_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}/api/internal/rwa-refresh` |
| Cron schedule | `15 */4 * * *` (UTC; must equal `RWA_REFRESH_CRON` and `vercel.json`, tested) |
| Restart policy | Never. No healthcheck, no public domain |
| Watch paths | `src/lib/rwa-refresh-trigger.ts`, `scripts/rwa-refresh-cron.ts`, `railway/rwa-refresh-cron.Dockerfile` |

The cron sends the same request as Vercel's cron (GET with the `CRON_SECRET` bearer). It logs only the target host,
the outcome and the HTTP status. Exit code 0 means the refresh ran, or the target answered "Refresh is disabled" (it
is the standby). Exit code 1 means misconfiguration or failure, and Railway shows the run as failed.
`SOFINANCE_RWA_REFRESH_URL` may also be a private URL, `http://<service>.railway.internal:8080/...`. Plain HTTP is
accepted only for `*.railway.internal` hosts.

## Who runs the refresh: never both

Each platform's cron calls its own deployment with GET. The route accepts a GET only where
`SOFINANCE_RWA_NATIVE_CRON_ENABLED=true` and `SOFINANCE_RWA_REFRESH_ENABLED=true`. Elsewhere it answers 503 "Refresh
is disabled", which the Railway cron treats as standby. Exactly one deployment owns the refresh:

1. **While Vercel serves production (now):** Vercel keeps `SOFINANCE_RWA_NATIVE_CRON_ENABLED=true`. On Railway `web`,
   set it to `false`. The Railway cron then logs `outcome: disabled` every 4 h, which shows the wiring works without
   double refreshes.
2. **Switching to Railway:** in one sitting, set Railway `web` to `true` (redeploy), then set Vercel to `false`
   (redeploy). For the minutes in between, both may run. That is harmless: every job takes a database lease and runs
   only when due, so a second call is a no-op.
3. **After DNS points at Railway:** disable the Vercel cron in the Vercel project settings. Otherwise Vercel's cron may
   call the production domain, which is now Railway. The lease still prevents a double run, but disabling it keeps
   the logs clean. `vercel.json` keeps its cron, so a rollback to Vercel needs only step 2 reversed.

## Env checklist (names only)

Enter values in the Railway dashboard, never in the repo. "Build" = must be present at build time, because it is
declared as an `ARG` in `railway/web.Dockerfile`. Railway passes service variables to the build only for declared
ARGs. Changing a **public** build value needs a redeploy (rebuild).

### `web`: copy from Vercel Production (same names, same values)

| Name | Build | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_POSTHOG_HOST` | public | |
| `NEXT_PUBLIC_POSTHOG_KEY` | public | |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | public | |
| `NEXT_PUBLIC_SENTRY_DSN` | public | |
| `SENTRY_AUTH_TOKEN` | sentry | Source-map upload only |
| `SENTRY_ORG` | sentry | |
| `SENTRY_PROJECT` | sentry | |
| `SENTRY_DSN` | server | |
| `CRON_SECRET` | server | ≥ 32 characters; the cron service references it |
| `DATABASE_URL` | server | Neon. Keep as is: `SOFINANCE_RWA_DATABASE_URL` takes precedence |
| `SOFINANCE_RWA_DATABASE_URL` | server | Railway Postgres TCP-proxy URL (as on Vercel) |
| `SOFINANCE_RWA_DB_CA_PEM` | server | Railway CA, pinned for the TCP proxy |
| `SOFINANCE_RWA_DB_ENABLED` | server | |
| `SOFINANCE_RWA_DB_EXPECTED_ROLE` | server | |
| `SOFINANCE_RWA_STORE_MODE` | server | |
| `SOFINANCE_RWA_GATEWAY_URL` | server | |
| `SOFINANCE_RWA_REFRESH_ENABLED` | server | |
| `SOFINANCE_RWA_NATIVE_CRON_ENABLED` | server | **`false` on Railway** until the switch above |
| `SOFINANCE_POSITION_HISTORY_DB_ENABLED` | server | |
| `SOFINANCE_FEE_WALLET` | server | |
| `RHC_UNIV4_FEE_WALLET` | server | |
| `JUPITER_API_KEY` | server | |
| `SOLANA_RPC_URL` | server | |
| `SOLANA_RPC_PROVIDERS` | server | |
| `ALCHEMY_RPC_URL` | server | Expanded inside `SOLANA_RPC_PROVIDERS` (`$ALCHEMY_RPC_URL`) |

Not needed (on Vercel, but no code reads them): `COINGECKO_API_KEY`, `SOLAMI_DATA_API_KEY`, `SOLAMI_RPC_URL`,
`RHC_RPC_URL` (read only by the local `scripts/rhc-token-registry.ts`).

### `web`: new on Railway

| Name | Build | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | public | `https://sofinancelab.xyz`. **Required.** Off Vercel there is no `VERCEL_URL`, so without it MCP `signUrl` and deep links become relative paths. Also used for canonical/SEO URLs |
| `RAILWAY_DOCKERFILE_PATH` | (builder) | `railway/web.Dockerfile` |
| `PORT` | runtime | `8080` (fixed, so the domain and private URL target a known port) |
| `SOFINANCE_TRUST_CLOUDFLARE_HEADERS` | runtime | `false`, or unset. Set `true` only once the domain is proxied through Cloudflare (see Geo) |

Optional, unset on Vercel today (keep unset for parity):

| Name | Build | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | public | |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | public | |
| `SENTRY_TRACES_SAMPLE_RATE` | runtime | |
| `SOFINANCE_SIGNING_SECRET`, `SOFINANCE_SIGNING_SECRET_PREVIOUS` | runtime | Falls back to `JUPITER_API_KEY`, as on Vercel |
| `SOFINANCE_FEE_BPS`, `SOFINANCE_RWA_DB_*` tuning | runtime | Defaults apply |

Never set `VERCEL`, `VERCEL_ENV` or `VERCEL_URL` on Railway. Without `VERCEL_ENV` the app treats itself as production,
as intended. Railway sets `RAILWAY_PROJECT_ID` and `RAILWAY_GIT_COMMIT_SHA` itself.

### `rwa-refresh-cron`

`RAILWAY_DOCKERFILE_PATH`, `CRON_SECRET` (reference `${{web.CRON_SECRET}}`), `SOFINANCE_RWA_REFRESH_URL`. Nothing
else.

## Geo signal and client IP

`src/lib/request-origin/` is the only place that reads edge headers:

- `country.ts` checks providers in order: Cloudflare `CF-IPCountry`, then Vercel `x-vercel-ip-country`. The first
  trusted provider with a value wins. If none has one, the country is unknown.
- `client-ip.ts` (rate limits) checks `CF-Connecting-IP` (trusted Cloudflare only), then `x-real-ip`, then the first
  `x-forwarded-for` entry.
- `trust.ts`: Cloudflare headers are believed only with `SOFINANCE_TRUST_CLOUDFLARE_HEADERS=true`. Vercel's geo
  header is believed everywhere except on Railway, where a client could send it.

**Unknown country (no trusted geo header) = today's missing-header behavior.** The proxy neither sets nor clears the
`sf_region_notice` cookie. A first-time visitor sees no region notice, and a visitor who already has the flag cookie
keeps seeing it until it expires (24 h). Nobody is ever blocked. So on Railway without Cloudflare, the region notice is
simply not shown. Putting Cloudflare (proxied) in front and setting `SOFINANCE_TRUST_CLOUDFLARE_HEADERS=true` brings it
back.

## Releases

Railway deploys `release` on push, exactly like Vercel, so `ship-pr.sh` (merge to `main`, "merged, not deployed") is
unchanged. `promote-release.sh` waits for a GitHub Deployment in environment `Production` with status `success`, which
Vercel's GitHub app creates. It needs a Railway-aware check before Railway is the production target (see the PR that
added this page).

## Vercel-specific behavior and what replaces it

| Vercel feature | In this repo | On Railway |
| --- | --- | --- |
| Cron (`vercel.json`) | `/api/internal/rwa-refresh` | `rwa-refresh-cron` service |
| `ignoreCommand` (`scripts/vercel-ignore-build.sh`) | skips doc-only builds | Not needed: Railway builds are free. Optional watch paths |
| `maxDuration` exports | 60 / 120 / 300 s caps | No function cap. Routes self-budget (refresh: 240 s); Railway's proxy allows 15 min |
| `after()` (MCP analytics) | runs on `waitUntil` | Runs in the long-lived process |
| ISR / `unstable_cache` / `revalidate` | Vercel data cache | Filesystem cache under `.next`, per instance, cleared on deploy. Fine with 1 replica |
| Image optimization | Vercel | `sharp` in the container |
| `x-vercel-ip-country` | region notice | `request-origin/country.ts` (above) |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_URL` | DB TLS rule, preview flags, public base URL | Unset: production behavior. `NEXT_PUBLIC_APP_URL` supplies the base URL |
| Vercel Firewall rate-limit rule | dashboard only (not in code) | **Not replaced yet.** In-app per-IP limits still apply. Add Cloudflare rules if needed |
| Global CDN | static assets and pages | Served from Singapore. Cloudflare in front is optional |

There are no `@vercel/*` packages, Edge Config, KV or Blob, and no Vercel Analytics or Speed Insights.

## Rollback

Vercel stays deployed and untouched until DNS moves. Before DNS: delete or stop the Railway services, with no user
impact. After DNS: point the records back at Vercel and reverse the refresh switch above.
