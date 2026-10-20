import * as Sentry from "@sentry/nextjs";
import { sentryInitOptions } from "@/lib/sentry/options";

Sentry.init(sentryInitOptions());

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
