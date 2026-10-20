import type { ErrorEvent } from "@sentry/nextjs";
import { applyRouteFromEvent } from "./route";
import { resolveSentryDsn, sentryTracesSampleRate } from "./runtime";
import { scrubSentryEvent } from "./scrub";

function prepareSentryEvent<T extends ErrorEvent>(event: T): T {
  applyRouteFromEvent(event);
  return scrubSentryEvent(event);
}

/** Shared Sentry.init options for client, server, and edge. No session replay. */
export function sentryInitOptions() {
  const dsn = resolveSentryDsn();
  return {
    dsn,
    enabled: Boolean(dsn),
    sendDefaultPii: false,
    tracesSampleRate: sentryTracesSampleRate(),
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [] as [],
      httpHeaders: {
        request: {
          deny: [
            "authorization",
            "cookie",
            "set-cookie",
            "proxy-authorization",
            "x-api-key",
            "x-cron-secret",
            "x-forwarded-for",
            "x-real-ip",
            "forwarded",
            "x-vercel-protection-bypass",
          ],
        },
      },
    },
    beforeSend(event: ErrorEvent) {
      return prepareSentryEvent(event);
    },
  };
}
