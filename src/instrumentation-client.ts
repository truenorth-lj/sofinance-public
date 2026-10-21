import { initSentryClient } from "@/lib/sentry/client";

initSentryClient();

export { onRouterTransitionStart } from "@/lib/sentry/client";
