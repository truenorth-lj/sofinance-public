import { initGrowthAnalytics } from "@/lib/analytics/client";

try {
  void initGrowthAnalytics();
} catch {
  // Client analytics must never break the app.
}
