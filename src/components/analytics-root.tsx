"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { captureGrowthEvent, capturePageview, initGrowthAnalytics } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { sanitizeAttrValue } from "@/lib/analytics/attribution";

export function AnalyticsRoot() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const last = useRef<string | null>(null);

  useEffect(() => {
    const query = search ? `?${search}` : "";
    const key = `${pathname}${query}`;
    void (async () => {
      const enabled = await initGrowthAnalytics(query);
      if (!enabled) return;
      if (last.current === key) return;
      last.current = key;
      capturePageview(pathname, window.location.href);
      if (pathname === "/app/rwa-pairs") {
        const ref = sanitizeAttrValue(searchParams.get("ref"));
        captureGrowthEvent(GROWTH_EVENTS.rwaPairsView, ref ? { ref } : {});
      }
    })();
  }, [pathname, search, searchParams]);

  return null;
}
