"use client";

import { useEffect } from "react";

/** Hides a server-rendered block after hydrate so JS users see only the interactive UI. */
export function HideOnMount({ targetId }: { targetId: string }) {
  useEffect(() => {
    document.getElementById(targetId)?.setAttribute("hidden", "");
  }, [targetId]);
  return null;
}
