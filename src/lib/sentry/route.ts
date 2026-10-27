import { scrubUnknown } from "./scrub";

/** Pathname only — never query string (wallets/signatures live there). */
export function pathnameFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
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
export function routeFromTransaction(transaction: unknown): string | undefined {
  if (typeof transaction !== "string" || !transaction) return undefined;
  const match = transaction.match(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/i);
  const raw = match?.[1] ?? (transaction.startsWith("/") ? transaction : undefined);
  if (!raw) return undefined;
  return raw.split("?")[0]?.replace(/\/+$/, "") || "/";
}

export function routeFromRequest(request: { url?: unknown } | undefined): string | undefined {
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
  // Classify/copy before merging: spreading raw tags would invoke accessors.
  const tags = scrubUnknown(event.tags);
  // The subsequent event scrub reserves a route slot explicitly, including
  // when decoded numeric keys enumerate before it, and scrubs the route itself.
  event.tags = { ...(tags && typeof tags === "object" ? tags : {}), route };
  return event;
}
