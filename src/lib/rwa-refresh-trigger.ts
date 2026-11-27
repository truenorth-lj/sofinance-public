/**
 * Calls `/api/internal/rwa-refresh` the way a scheduler does, and classifies the answer.
 *
 * Shared by every caller that is not Vercel's own cron:
 * - the Railway cron service (`scripts/rwa-refresh-cron.ts`, run on `RWA_REFRESH_CRON`; docs/deploy/railway.md);
 * - the self-hosted data service's scheduler (`scripts/rwa-data-service.ts`).
 *
 * The Railway cron image runs this file with Node's built-in TypeScript type stripping and no `node_modules`, so it
 * must stay dependency-free: no imports, erasable TypeScript only (no enums, namespaces or parameter properties).
 * Nothing here logs or returns the secret or the URL's query.
 */

/** Exact `error` the route answers (HTTP 503) when refresh is switched off on that deployment. */
export const RWA_REFRESH_DISABLED_ERROR = "Refresh is disabled";

export type RwaRefreshMethod = "GET" | "POST";

export type RwaRefreshOutcome =
  /** 2xx: the refresh ran (each job still applies its own due/lease admission). */
  | { readonly kind: "ran"; readonly status: number }
  /** 503 "Refresh is disabled": this deployment is the standby, not the scheduler owner. */
  | { readonly kind: "disabled"; readonly status: number }
  /** Any other answer, or no answer (`status: null`: network error or timeout). */
  | { readonly kind: "failed"; readonly status: number | null };

export interface RwaRefreshUrlPolicy {
  /** Allow plain `http:` to a Railway private-network host (`*.railway.internal`). */
  readonly allowRailwayPrivateHttp: boolean;
}

/** Parses a refresh URL: HTTPS (or opted-in Railway private HTTP), no embedded credentials. Throws otherwise. */
export function parseRwaRefreshUrl(raw: string | undefined, policy: RwaRefreshUrlPolicy): URL {
  if (!raw?.trim()) throw new Error("RWA refresh URL is not configured");
  const url = new URL(raw.trim());
  const railwayPrivate = url.protocol === "http:" && url.hostname.endsWith(".railway.internal");
  if (url.protocol !== "https:" && !(policy.allowRailwayPrivateHttp && railwayPrivate))
    throw new Error("RWA refresh URL must use HTTPS");
  if (url.username || url.password) throw new Error("RWA refresh URL must not embed credentials");
  return url;
}

export interface TriggerRwaRefreshInput {
  readonly url: URL;
  readonly secret: string;
  /** GET mirrors Vercel's cron and is gated by `SOFINANCE_RWA_NATIVE_CRON_ENABLED`; POST `{}` is not. */
  readonly method: RwaRefreshMethod;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export async function triggerRwaRefresh(input: TriggerRwaRefreshInput): Promise<RwaRefreshOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: input.method,
      headers: input.method === "POST"
        ? { Authorization: `Bearer ${input.secret}`, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${input.secret}` },
      body: input.method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    return { kind: "failed", status: null };
  }
  if (response.ok) return { kind: "ran", status: response.status };
  if (response.status === 503 && (await disabledBody(response))) return { kind: "disabled", status: 503 };
  return { kind: "failed", status: response.status };
}

async function disabledBody(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && (body as { error?: unknown }).error === RWA_REFRESH_DISABLED_ERROR;
  } catch {
    return false;
  }
}

/** Below Railway's 15-minute proxy limit and above the route's own 300 s budget, so the route always answers first. */
export const RWA_REFRESH_CRON_TIMEOUT_MS = 330_000;

export interface RwaRefreshCronDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly log: (line: string) => void;
}

/**
 * One Railway cron run. Returns the process exit code: 0 when the refresh ran or the target is the standby
 * (refresh disabled there), 1 on misconfiguration or failure so Railway marks the run failed.
 */
export async function runRwaRefreshCron(deps: RwaRefreshCronDeps): Promise<number> {
  const { log } = deps;
  const secret = deps.env.CRON_SECRET ?? "";
  let url: URL;
  try {
    url = parseRwaRefreshUrl(deps.env.SOFINANCE_RWA_REFRESH_URL, { allowRailwayPrivateHttp: true });
  } catch (error) {
    log(`rwa-refresh-cron config error: ${(error as Error).message}`);
    return 1;
  }
  if (secret.length < 32) {
    log("rwa-refresh-cron config error: CRON_SECRET is missing or shorter than 32 characters");
    return 1;
  }
  const outcome = await triggerRwaRefresh({ url, secret, method: "GET", timeoutMs: RWA_REFRESH_CRON_TIMEOUT_MS, fetchImpl: deps.fetchImpl });
  log(`rwa-refresh-cron ${JSON.stringify({ host: url.host, outcome: outcome.kind, status: outcome.status })}`);
  return outcome.kind === "failed" ? 1 : 0;
}
