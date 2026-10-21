import { initSentryClient } from "@/lib/sentry/client";
import { initGrowthAnalytics } from "@/lib/analytics/client";

initSentryClient();

try {
  void initGrowthAnalytics();
} catch {
  // Client analytics must never break the app.
}

export { onRouterTransitionStart } from "@/lib/sentry/client";
