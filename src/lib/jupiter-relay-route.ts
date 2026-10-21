import "server-only";
import { JUPITER_RELAY_NEEDED_CODE, parseJupiterRelay, parseJupiterRelayHints, runWithJupiterRelay } from "@sofinance/engine/jupiter/relay";

/** Sizing hints for the next relay round / prepare (see `jupiterRelayHint`). */
export const JUPITER_RELAY_HINTS_HEADER = "x-jupiter-relay-hints";

/**
 * Browser-fetched Jupiter (keyless, the user's own per-IP quota). When the body
 * carries `jupiterRelay`, the route's normal engine code runs against those
 * responses instead of calling Jupiter with the server key. Any response the
 * engine still needs comes back as 409 `jupiter_relay_needed` with the exact
 * requests; the browser fetches them and posts again. Without `jupiterRelay`
 * (MCP/agents, old clients) nothing changes: the server quotes with its key.
 *
 * Product decision: client-supplied Jupiter output is trusted. The engine's own
 * mint/amount/slippage/price-impact/program-allowlist checks and the server-side
 * simulation still run unchanged.
 */
export async function withJupiterRelay(request: Request, run: () => Promise<Response>): Promise<Response> {
  let relay: ReturnType<typeof parseJupiterRelay>;
  let hints: ReturnType<typeof parseJupiterRelayHints> = new Map();
  try {
    const body: unknown = await request.clone().json();
    const field = body && typeof body === "object" ? (body as { jupiterRelay?: unknown }).jupiterRelay : undefined;
    relay = parseJupiterRelay(field);
    if (relay) hints = parseJupiterRelayHints((field as { hints?: unknown }).hints);
  } catch (error) {
    if (error instanceof SyntaxError) return run();
    return Response.json({ error: error instanceof Error ? error.message : "Invalid jupiterRelay" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!relay) return run();
  const outcome = await runWithJupiterRelay(relay, run, hints);
  if (outcome.needs) {
    return Response.json({ code: JUPITER_RELAY_NEEDED_CODE, error: "Jupiter quotes required", needs: outcome.needs, hints: outcome.hints },
      { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  const response = outcome.value;
  if (Object.keys(outcome.hints).length === 0) return response;
  const headers = new Headers(response.headers);
  headers.set(JUPITER_RELAY_HINTS_HEADER, JSON.stringify(outcome.hints));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
