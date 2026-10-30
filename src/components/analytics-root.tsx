"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { capturePageview, initGrowthAnalytics } from "@/lib/analytics/client";

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
      // `/app/rwa-pairs` is retired (307 to `/app#pools`, `ref` kept), so `rwa_pairs_view` no longer fires; the
      // `/app` pageview carries the same `ref` in `$current_url`.
      capturePageview(pathname, window.location.href);
    })();
  }, [pathname, search]);

  return null;
}
