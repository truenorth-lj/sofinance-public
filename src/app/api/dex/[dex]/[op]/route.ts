import "@/lib/engine-host";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { apiError } from "@/lib/api-response";
import { dexRegistry, DexError, publicDexMessage, type DexAdapter, type DexErrorCode, type OpenRequest, type StepContext, type StepResult } from "@/lib/dex";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { isDexTxRouteEnabled } from "@/lib/protocol-flags";
import { txPermitsFor } from "@/lib/tx-send/permit";
import type { PositionKey } from "@/lib/unified-positions/model";

/**
 * POST /api/dex/[dex]/[op] — the one API entry for every DEX (DESIGN.md §1.2). Validates the body, resolves the
 * adapter through the registry and calls it; no DEX is named here.
 *   quote-open  { request }                                    → OpenQuote
 *   open        { request, step, priorSignatures, planToken? } → StepResult (one unsigned, simulated step)
 *   recovery    { wallet, positionKey, step, priorSignatures, planToken? } → StepResult
 * Solana steps come back with the tx-send permits for the requesting wallet (relay send + on-chain check after a
 * wallet error). Jupiter goes through the browser relay when the body carries `jupiterRelay`. Nothing is signed or
 * sent here. Behind DEX_TX_ROUTE_ENABLED (off in production → 404).
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const notFound = () => json({ error: "Not found" }, 404);

const solanaOrEvmAddress = z.string().trim().min(32).max(64);
const rawAmount = z.string().regex(/^\d{1,40}$/, "amountRaw must be a whole number of raw units");
const OpenRequestSchema = z.object({
  poolId: z.string().trim().min(1).max(64),
  owner: solanaOrEvmAddress,
  range: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), presetId: z.string().min(1).max(32) }),
    z.object({ kind: z.literal("units"), lower: z.number().int(), upper: z.number().int() }),
  ]),
  input: z.object({ token: z.string().trim().min(1).max(64), amountRaw: rawAmount }).strict(),
  slippageBps: z.number().int().min(0).max(10_000),
  /**
   * Public key only (32-44 base58 chars). The server never accepts a cosigner secret: a 64-byte secret key does not fit,
   * a byte array is not a string, and unknown fields (e.g. `cosignerSecret`) are rejected by `.strict()`.
   */
  cosigner: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "cosigner must be a public key").optional(),
}).strict();
const StepSchema = {
  step: z.number().int().min(1).max(16),
  priorSignatures: z.array(z.string().min(1).max(128)).max(16),
  planToken: z.string().min(1).max(512).optional(),
};
const BODY = {
  "quote-open": z.object({ request: OpenRequestSchema, jupiterRelay: z.unknown().optional() }).strict(),
  open: z.object({ request: OpenRequestSchema, ...StepSchema, jupiterRelay: z.unknown().optional() }).strict(),
  recovery: z.object({ wallet: solanaOrEvmAddress, positionKey: z.string().min(3).max(160), ...StepSchema, jupiterRelay: z.unknown().optional() }).strict(),
} as const;
type Op = keyof typeof BODY;
const isOp = (op: string): op is Op => Object.hasOwn(BODY, op);

const STATUS: Record<DexErrorCode, number> = {
  UNSUPPORTED: 422, TOKEN_RESTRICTED: 422, RANGE_UNSUPPORTED: 422, NEEDS_NEW_SHARED_ACCOUNT: 422, INPUT_TOKEN_UNSUPPORTED: 422,
  INSUFFICIENT_FUNDS: 422, POSITION_NOT_FOUND: 404, INVALID_REQUEST: 400, UPSTREAM: 502, MISCONFIGURED: 503,
};

/** A Solana step must be paid by the requesting wallet; it then carries that wallet's send / landed permits. */
function withPermits(result: StepResult, wallet: string): StepResult {
  const { prepared } = result;
  if (prepared.kind !== "solana-tx") return result;
  const payer = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64")).message.staticAccountKeys[0];
  if (!payer || !payer.equals(new PublicKey(wallet))) throw new DexError("UPSTREAM", "The prepared transaction is not paid by your wallet, so it was not returned.");
  return { ...result, prepared: { ...prepared, ...txPermitsFor(wallet, prepared.transaction, prepared.lastValidBlockHeight) } };
}

function stepContext(body: { step: number; priorSignatures: string[]; planToken?: string }): StepContext {
  return { step: body.step, priorSignatures: body.priorSignatures, ...(body.planToken ? { planToken: body.planToken } : {}) };
}

async function run(adapter: DexAdapter, op: Op, body: unknown): Promise<Response> {
  switch (op) {
    case "quote-open": {
      const { request } = BODY[op].parse(body);
      return json(await adapter.quoteOpen(request as OpenRequest));
    }
    case "open": {
      const input = BODY[op].parse(body);
      const request = input.request as OpenRequest;
      return json(withPermits(await adapter.prepareOpen(request, stepContext(input)), request.owner));
    }
    case "recovery": {
      const input = BODY[op].parse(body);
      if (!adapter.prepareRecovery) throw new DexError("UNSUPPORTED", "This DEX has no recovery step.");
      return json(withPermits(await adapter.prepareRecovery(input.positionKey as PositionKey, input.wallet, stepContext(input)), input.wallet));
    }
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ dex: string; op: string }> }) {
  if (!isDexTxRouteEnabled()) return notFound();
  const { dex, op } = await params;
  if (!isOp(op)) return notFound();
  const adapter = await dexRegistry.adapterFor(dex);
  if (!adapter) return notFound();
  return withJupiterRelay(request, async () => {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    try {
      return await run(adapter, op, body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return json({ error: "Invalid request", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 400);
      }
      if (error instanceof DexError) return json({ error: publicDexMessage(error.message), code: error.code }, STATUS[error.code]);
      // apiError rethrows the Jupiter relay round-trip, reports to Sentry and maps known upstream errors; its message is
      // then put through the same public filter (a thrown message can embed a stack frame or a URL).
      const response = apiError(error, "DEX request failed", 503);
      const body = await response.json() as { error?: string } & Record<string, unknown>;
      return json({ ...body, error: publicDexMessage(body.error ?? "") }, response.status);
    }
  });
}

export function GET() {
  return notFound();
}
