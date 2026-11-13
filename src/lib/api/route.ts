import { NO_STORE_HEADERS } from "@/lib/http/no-store";
import type { ZodType } from "zod";

/** Re-export of the shared no-store header so route handlers share one constant. */
export const NO_STORE = NO_STORE_HEADERS;

/** JSON response with `Cache-Control: no-store`. Extra headers (e.g. Retry-After) are merged in. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * Parse the request body as JSON and validate it with `schema`.
 * Invalid JSON → 400 `{ error: "Invalid JSON" }`.
 * Failed parse → 400 `{ error: "Invalid request", issues }`.
 */
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return json({
      error: "Invalid request",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    }, 400);
  }
  return parsed.data;
}

/** Run `handler` only when `enabled()` is true; otherwise 404 `{ error: "Not found" }` (no-store). */
export function gated(
  enabled: () => boolean,
  handler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!enabled()) return json({ error: "Not found" }, 404);
    return handler(request);
  };
}
