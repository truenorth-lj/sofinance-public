import "server-only";

export function apiError(error: unknown, fallback: string, status = 400) {
  const message = error instanceof Error ? error.message : fallback;
  // Provider failures can contain credential-bearing RPC URLs. Only our own
  // short domain errors are returned to the browser.
  const safe = message.length <= 300 && !/https?:\/\/|api[_-]?key|authorization|token=/i.test(message);
  return Response.json({ error: safe ? message : fallback }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
