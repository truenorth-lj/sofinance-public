/** Pathname only — never query string (wallets/signatures live there). */
export function pathnameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const path = new URL(url, "http://local.invalid").pathname;
    if (!path || path === "/") return path || undefined;
    return path.replace(/\/+$/, "") || "/";
  } catch {
    const match = url.match(/^[^?#]+/);
    const path = match?.[0]?.replace(/^https?:\/\/[^/]+/i, "");
    if (!path) return undefined;
    return path.replace(/\/+$/, "") || "/";
  }
}

/** `GET /api/wallet` or `/api/wallet` → `/api/wallet`. */
export function routeFromTransaction(transaction: string | undefined): string | undefined {
  if (!transaction) return undefined;
  const match = transaction.match(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/i);
  const raw = match?.[1] ?? (transaction.startsWith("/") ? transaction : undefined);
  if (!raw) return undefined;
  return raw.split("?")[0]?.replace(/\/+$/, "") || "/";
}

export function routeFromRequest(request: { url: string } | undefined): string | undefined {
  return request ? pathnameFromUrl(request.url) : undefined;
}

export function routeFromSentryEvent(event: {
  transaction?: string;
  request?: { url?: string };
}): string | undefined {
  return pathnameFromUrl(event.request?.url) ?? routeFromTransaction(event.transaction);
}

/** Prefer the request path / Next transaction over any previously guessed tag. */
export function applyRouteFromEvent<T extends {
  tags?: Record<string, unknown>;
  transaction?: string;
  request?: { url?: string };
}>(event: T): T {
  const route = routeFromSentryEvent(event);
  if (!route) return event;
  event.tags = { ...event.tags, route };
  return event;
}
