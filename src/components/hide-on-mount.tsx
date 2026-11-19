"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribeIsClient = () => () => {};

/**
 * Keeps server-rendered children in the initial HTML (curl, no-JS, crawlers), then unmounts them after hydrate
 * so JS users and e2e locators see only the interactive UI.
 *
 * Do not `element.remove()` a React-managed node: when the Reown provider swaps in after mount, React's unmount
 * of the previous tree throws `NotFoundError: Failed to execute 'removeChild'`.
 */
export function HideOnMount({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribeIsClient, () => true, () => false);
  if (mounted) return null;
  return children;
}
