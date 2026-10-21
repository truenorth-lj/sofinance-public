import * as Sentry from "@sentry/nextjs";
import { sentryInitOptions } from "./options";

/** Browser Sentry init. Call from `instrumentation-client.ts`. */
export function initSentryClient(): void {
  Sentry.init(sentryInitOptions());
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
