import { createHash } from "node:crypto";
import { posthogUpstream } from "./relay";

/**
 * Server-side PostHog capture (code-only events; no PostHog project settings).
 *
 * - Production only (`VERCEL_ENV=production`) and only when the existing public project key is set: previews, local
 *   dev and tests send nothing, so no billed events from them.
 * - One HTTP call per request: every event from that request goes in one `/batch/` body.
 * - Personless (`$process_person_profile: false`) and `$geoip_disable: true`. The client IP is never a property;
 *   PostHog only sees our server as the sender.
 * - Fire and forget with a short timeout. A failed capture is dropped, never retried, never reported.
 */

export type ServerEventProperties = Record<string, string | number | boolean>;
export type ServerEvent = { event: string; distinctId: string; properties: ServerEventProperties };

const CAPTURE_TIMEOUT_MS = 2_000;

/** Same `wallet:<sha256 hex>` id the web app used before and sofi-metrics already folds with raw addresses. */
export function walletDistinctId(wallet: string): string {
  return `wallet:${createHash("sha256").update(wallet, "utf8").digest("hex")}`;
}

type Env = Record<string, string | undefined>;

function runtimeEnv(): Env {
  return {
    VERCEL_ENV: process.env.VERCEL_ENV,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  };
}

function captureKey(env: Env): string | null {
  if (env.VERCEL_ENV !== "production") return null;
  return env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || null;
}

/** True only where events are actually sent (production with the project key). Gates extra work such as RPC polls. */
export function serverAnalyticsEnabled(env: Env = runtimeEnv()): boolean {
  return captureKey(env) !== null;
}

export async function sendServerEvents(
  events: readonly ServerEvent[],
  { env = runtimeEnv(), fetchImpl = fetch, now = () => new Date() }: { env?: Env; fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<void> {
  const apiKey = captureKey(env);
  if (!apiKey || events.length === 0) return;
  const timestamp = now().toISOString();
  const batch = events.map((item) => ({
    event: item.event,
    distinct_id: item.distinctId,
    timestamp,
    properties: { ...item.properties, $process_person_profile: false, $geoip_disable: true, $lib: "sofinance-server" },
  }));
  try {
    await fetchImpl(`${posthogUpstream(env.NEXT_PUBLIC_POSTHOG_HOST).ingest}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, batch }),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
  } catch {
    // Analytics must never affect the request or page anyone.
  }
}
