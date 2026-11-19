"use client";

import { useEffect } from "react";

/**
 * Removes a server-rendered block after hydrate so JS users (and e2e locators like `h1`) see only the interactive UI.
 * The markup stays in the initial HTML for curl and no-JS clients.
 */
export function HideOnMount({ targetId }: { targetId: string }) {
  useEffect(() => {
    document.getElementById(targetId)?.remove();
  }, [targetId]);
  return null;
}
