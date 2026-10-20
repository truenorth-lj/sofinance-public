import type { ErrorEvent } from "@sentry/nextjs";
import { resolveSentryDsn, sentryTracesSampleRate } from "./runtime";
import { scrubSentryEvent } from "./scrub";

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
    beforeSend(event: ErrorEvent) {
      return scrubSentryEvent(event);
    },
  };
}
