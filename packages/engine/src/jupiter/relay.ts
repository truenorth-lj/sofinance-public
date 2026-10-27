/**
 * Server-only Jupiter relay. The browser fetches Jupiter keylessly (its own
 * per-IP quota) and posts the raw responses back; the server replays its usual
 * quote/build code against them instead of calling Jupiter itself.
 *
 * A request whose response is missing is recorded as a "need" and aborts the
 * run. The route answers `jupiter_relay_needed` with those needs; the browser
 * fetches them and retries with the responses added. Results are trusted as
 * Jupiter output (product decision): the usual mint, amount, slippage,
 * price-impact and program-allowlist checks still run on them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  JupiterRelayMissingError,
  setJupiterRelayResolver,
  type JupiterRelayRequest,
  type JupiterRelayResponse,
} from "./client";
import { JUPITER_QUOTE_PATH, JUPITER_SWAP_INSTRUCTIONS_PATH } from "./urls";

export type { JupiterRelayRequest, JupiterRelayResponse } from "./client";
export { JupiterRelayMissingError } from "./client";

export type JupiterRelayNeed = JupiterRelayRequest & { id: string };
export const JUPITER_RELAY_NEEDED_CODE = "jupiter_relay_needed";
export const JUPITER_RELAY_MAX_RESPONSES = 48;
const MAX_RESPONSE_JSON_CHARS = 400_000;
const RELAY_PATHS = new Set([JUPITER_QUOTE_PATH, JUPITER_SWAP_INSTRUCTIONS_PATH]);

type RelayContext = { responses: Map<string, JupiterRelayResponse>; needs: Map<string, JupiterRelayNeed>; hints: Map<string, string> };
export const JUPITER_RELAY_MAX_HINTS = 16;
const storage = new AsyncLocalStorage<RelayContext>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Deterministic id of a Jupiter request (method + path/query + canonical JSON body). */
export function jupiterRelayId(request: JupiterRelayRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.method, request.url, request.body === undefined ? null : canonical(request.body)]))
    .digest("hex").slice(0, 32);
}

setJupiterRelayResolver({
  active: () => storage.getStore() !== undefined,
  resolve(request) {
    const context = storage.getStore();
    if (!context) return undefined;
    const id = jupiterRelayId(request);
    const hit = context.responses.get(id);
    if (hit) return hit;
    if (!RELAY_PATHS.has(request.url.split("?")[0]!)) return undefined;
    context.needs.set(id, { id, ...request });
    return "missing";
  },
  hint: key => storage.getStore()?.hints.get(key),
  setHint(key, value) {
    const hints = storage.getStore()?.hints;
    if (!hints) return;
    hints.delete(key);
    hints.set(key, value);
    while (hints.size > JUPITER_RELAY_MAX_HINTS) hints.delete(hints.keys().next().value!);
  },
});

/** Validates the untrusted `jupiterRelay.hints` field. */
export function parseJupiterRelayHints(value: unknown): Map<string, string> {
  const hints = new Map<string, string>();
  if (value === undefined || value === null) return hints;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid jupiterRelay hints");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > JUPITER_RELAY_MAX_HINTS) throw new Error("Too many jupiterRelay hints");
  for (const [key, hint] of entries) {
    if (key.length > 300 || typeof hint !== "string" || !/^\d{1,40}$/.test(hint)) throw new Error("Invalid jupiterRelay hint");
    hints.set(key, hint);
  }
  return hints;
}

/** Validates the untrusted `jupiterRelay` request field. `null` means "not in relay mode". */
export function parseJupiterRelay(value: unknown): Map<string, JupiterRelayResponse> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid jupiterRelay");
  const responses = (value as { responses?: unknown }).responses ?? {};
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) throw new Error("Invalid jupiterRelay responses");
  const entries = Object.entries(responses as Record<string, unknown>);
  if (entries.length > JUPITER_RELAY_MAX_RESPONSES) throw new Error("Too many jupiterRelay responses");
  const map = new Map<string, JupiterRelayResponse>();
  for (const [id, entry] of entries) {
    if (!/^[0-9a-f]{32}$/.test(id) || !entry || typeof entry !== "object") throw new Error("Invalid jupiterRelay response");
    const { status, body, retryAfterMs } = entry as { status?: unknown; body?: unknown; retryAfterMs?: unknown };
    if (!Number.isInteger(status) || (status as number) < 200 || (status as number) > 599) throw new Error("Invalid jupiterRelay status");
    if (JSON.stringify(body ?? null).length > MAX_RESPONSE_JSON_CHARS) throw new Error("jupiterRelay response too large");
    map.set(id, { status: status as number, body: body ?? null,
      retryAfterMs: typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null });
  }
  return map;
}

// Parallel legs (Promise.all) reject on the first missing response; give the
// sibling legs a tick to record theirs so one round fetches them all.
const settleSiblings = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export type JupiterRelayOutcome<T> = ({ needs: null; value: T } | { needs: JupiterRelayNeed[]; value?: undefined }) & {
  /** Allocation hints to echo back on the next round / the prepare request. */
  hints: Record<string, string>;
};

/**
 * Runs `run` against the supplied responses. Any missing response wins over the
 * run's own result or error: a catch-and-fallback path inside the engine must
 * never turn "not fetched yet" into a degraded answer.
 */
export async function runWithJupiterRelay<T>(
  responses: Map<string, JupiterRelayResponse>, run: () => Promise<T>, hints: Map<string, string> = new Map(),
): Promise<JupiterRelayOutcome<T>> {
  const context: RelayContext = { responses, needs: new Map(), hints: new Map(hints) };
  const hintsOut = () => Object.fromEntries(context.hints);
  try {
    const value = await storage.run(context, run);
    await settleSiblings();
    return context.needs.size ? { needs: [...context.needs.values()], hints: hintsOut() } : { needs: null, value, hints: hintsOut() };
  } catch (error) {
    await settleSiblings();
    if (context.needs.size) return { needs: [...context.needs.values()], hints: hintsOut() };
    if (error instanceof JupiterRelayMissingError) throw new Error("Jupiter relay state lost");
    throw error;
  }
}
