/**
 * Post-start ISR warm-up for a self-hosted `next start` (the Railway `web` image; docs/deploy/railway.md).
 *
 * Railway builds have no server secrets (no database), so the ISR pages that read the RWA store are prerendered from
 * their no-store fallback. Left alone, `next start` would serve that thin build-time copy until its `revalidate`
 * window (15 min) runs out. Right after the server answers `/api/health`, this asks the app to revalidate those paths
 * (`/api/internal/revalidate`, CRON_SECRET bearer, Railway only) and requests each one until a fresh render is served,
 * so the runtime env fills them within seconds of start. Vercel builds with the store and never runs this.
 *
 * Runs inside `scripts/railway-web-start.ts` with Node's type stripping, so it must stay dependency-free: no imports,
 * erasable TypeScript only. Nothing here logs the secret.
 */

/**
 * ISR routes whose prerender reads the RWA store at build. Static paths only: dynamic segments (`/pools/[slug]`)
 * already skip the build-time prerender when the snapshot is empty and render on first request.
 * `src/lib/isr-warmup.test.ts` keeps this list equal to the app's static ISR routes.
 */
export const ISR_WARMUP_PATHS = ["/", "/sitemap.xml"] as const;

export const ISR_REVALIDATE_ROUTE = "/api/internal/revalidate";

export type IsrWarmupResult = "warmed" | "skipped" | "failed";

export interface IsrWarmupDeps {
  /** Loopback base of the local server, e.g. `http://127.0.0.1:8080`. */
  readonly baseUrl: string;
  readonly secret: string | undefined;
  readonly log: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for `/api/health` before giving up (default 120 s). */
  readonly readyTimeoutMs?: number;
  /** Requests per path while the old copy is still served (`x-nextjs-cache: STALE`); default 15, 1 s apart. */
  readonly renderAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function request(deps: IsrWarmupDeps, path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await (deps.fetchImpl ?? fetch)(new URL(path, deps.baseUrl), { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    return null;
  }
}

async function waitUntilReady(deps: IsrWarmupDeps, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const attempts = Math.ceil((deps.readyTimeoutMs ?? 120_000) / 1000);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request(deps, "/api/health");
    if (response?.ok) return true;
    await sleep(1000);
  }
  return false;
}

/** Requests `path` until the server stops serving the pre-revalidation copy; returns the last answer's facts. */
async function renderFresh(deps: IsrWarmupDeps, path: string, sleep: (ms: number) => Promise<void>) {
  const attempts = deps.renderAttempts ?? 15;
  let last = { status: null as number | null, cache: null as string | null, bytes: 0 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request(deps, path);
    if (response) {
      const body = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
      last = { status: response.status, cache: response.headers.get("x-nextjs-cache"), bytes: body.byteLength };
      if (response.ok && last.cache !== "STALE") return last;
    }
    await sleep(1000);
  }
  return last;
}

export async function runIsrWarmup(deps: IsrWarmupDeps): Promise<IsrWarmupResult> {
  const sleep = deps.sleep ?? defaultSleep;
  if (!deps.secret || deps.secret.length < 32) {
    deps.log("isr-warmup skipped: CRON_SECRET is not set");
    return "skipped";
  }
  if (!(await waitUntilReady(deps, sleep))) {
    deps.log("isr-warmup failed: server did not become healthy");
    return "failed";
  }
  const revalidated = await request(deps, ISR_REVALIDATE_ROUTE, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.secret}` },
  });
  if (!revalidated?.ok) {
    deps.log(`isr-warmup failed: revalidate answered ${revalidated?.status ?? "no response"}`);
    return "failed";
  }
  let fresh = true;
  for (const path of ISR_WARMUP_PATHS) {
    const result = await renderFresh(deps, path, sleep);
    fresh &&= result.status === 200 && result.cache !== "STALE";
    deps.log(`isr-warmup ${JSON.stringify({ path, ...result })}`);
  }
  return fresh ? "warmed" : "failed";
}
