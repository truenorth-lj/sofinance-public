import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { applyRouteFromEvent } from "./route";
import { resolveSentryDsn, sentryTracesSampleRate } from "./runtime";
import { minimalSentryEvent, scrubBreadcrumb, scrubSentryEvent } from "./scrub";

export const LAST_RESORT_SENTRY_MESSAGE = "Application error";

function prepareSentryEvent<T extends ErrorEvent>(event: T): T {
  applyRouteFromEvent(event);
  return scrubSentryEvent(event);
}

function lastResortSentryEvent(event: ErrorEvent): ErrorEvent {
  let route: string | undefined;
  try {
    route = typeof event.tags?.route === "string" ? event.tags.route : undefined;
  } catch {
    route = undefined;
  }
  return {
    message: LAST_RESORT_SENTRY_MESSAGE,
    tags: route ? { route } : {},
  } as ErrorEvent;
}

function safeBeforeSend(event: ErrorEvent): ErrorEvent {
  try {
    return prepareSentryEvent(event);
  } catch {
    try {
      return minimalSentryEvent(event);
    } catch {
      return lastResortSentryEvent(event);
    }
  }
}

function safeBeforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  try {
    return scrubBreadcrumb(breadcrumb);
  } catch {
    return null;
  }
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
      return safeBeforeSend(event);
    },
    beforeBreadcrumb(breadcrumb: Breadcrumb) {
      return safeBeforeBreadcrumb(breadcrumb);
    },
  };
}
