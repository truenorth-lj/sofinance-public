import { readPortfolio } from "@/lib/dex";
import { portfolioRequestSchema } from "@/lib/portfolio/model";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";
import { dexRouteRateLimited } from "@/lib/dex-route-rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 60_000;
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks).toString("utf8");
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
}

/** Compact figures for the wallet's discovered Solana positions. No transaction is prepared, signed or sent. */
export async function POST(request: Request) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE_HEADERS });
  if (dexRouteRateLimited(request, "performance")) return Response.json({ error: "Too many requests. Please wait a minute." }, {
    status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": "60" },
  });
  // Bound the body before decoding; keys and signature arrays also have their own strict limits.
  let input;
  try {
    const text = await readBody(request);
    if (text === null) return json({ error: "Portfolio request is too large." }, 413);
    input = portfolioRequestSchema.parse(JSON.parse(text));
  }
  catch { return json({ error: "Invalid portfolio request." }, 400); }
  try {
    return json(await readPortfolio(input, AbortSignal.any([request.signal, AbortSignal.timeout(45_000)])));
  } catch {
    return json({ error: "Portfolio is temporarily unavailable. Please try again shortly." }, 503);
  }
}
