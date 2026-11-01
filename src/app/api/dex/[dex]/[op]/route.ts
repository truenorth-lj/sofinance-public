import "@/lib/engine-host";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { apiError } from "@/lib/api-response";
import { dexRegistry, DexError, publicDexMessage, type DexAdapter, type DexErrorCode, type DexSigner, type OpenRequest, type StepContext, type StepResult } from "@/lib/dex";
import { dexRouteRateLimited } from "@/lib/dex-route-rate-limit";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { isDexTxRouteEnabled } from "@/lib/protocol-flags";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { WITHDRAW_OUTPUTS, type PositionKey } from "@/lib/unified-positions/model";

/**
 * POST /api/dex/[dex]/[op] — the one API entry for every DEX (DESIGN.md §1.2). Validates the body, resolves the
 * adapter through the registry and calls it; no DEX is named here.
 *   quote-open  { request }                                    → OpenQuote
 *   open        { request, step, priorSignatures, planToken? } → StepResult (one unsigned, simulated step)
 *   recovery    { wallet, positionKey, step, priorSignatures, planToken? } → StepResult
 *   positions   { owner }                                      → { positions: UnifiedPosition[] } (read-only)
 *   performance { positionKey }                                → PositionPerformance (read-only; public chain data)
 *   add         { owner, positionKey, input, step, priorSignatures, planToken? }           → StepResult
 *   withdraw    { owner, positionKey, fraction, output, step, priorSignatures, planToken? } → StepResult
 *   claim       { owner, positionKey, step, priorSignatures, planToken? }                  → StepResult
 * Position ops: the owner is validated per wallet type here and checked against the position's on-chain owner inside
 * the adapter (a stranger gets 404 POSITION_NOT_FOUND).
 * Solana steps come back with the tx-send permits for the requesting wallet (relay send + on-chain check after a
 * wallet error). Jupiter goes through the browser relay when the body carries `jupiterRelay`. Nothing is signed or
 * sent here. Behind DEX_TX_ROUTE_ENABLED (off in production → 404). Per-IP rate limited (all ops, plus a tighter
 * `positions` limit; in-memory per instance, see dex-route-rate-limit.ts) → 429.
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
/**
 * The `positions` owner, by the DEX's wallet type (descriptor `capabilities.signer`, never a DEX id): a Solana wallet is
 * a base58 public key that decodes to 32 bytes; an EVM wallet is a 0x address. Anything else is a 400 before any read.
 */
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isSolanaPublicKey = (value: string) => {
  if (!BASE58_PUBKEY.test(value)) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
};
const OWNER: Record<DexSigner, z.ZodType<string>> = {
  "solana-wallet": z.string().trim().refine(isSolanaPublicKey, "owner must be a Solana wallet address (base58 public key)"),
  "evm-wallet": z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "owner must be an EVM wallet address (0x…)"),
};
const positionsBody = (adapter: DexAdapter) => z.object({ owner: OWNER[adapter.descriptor.capabilities.signer] }).strict();
const PositionKeySchema = z.string().min(3).max(160);
/** add / withdraw / claim / compound: the requesting wallet (checked per wallet type here, and against the position's on-chain owner in the adapter). */
const positionOpBody = (adapter: DexAdapter) => {
  const common = { owner: OWNER[adapter.descriptor.capabilities.signer], positionKey: PositionKeySchema, ...StepSchema, jupiterRelay: z.unknown().optional() };
  return {
    add: z.object({ ...common, input: z.object({ token: z.string().trim().min(1).max(64), amountRaw: rawAmount }).strict() }).strict(),
    withdraw: z.object({
      ...common,
      /** Share of the position, (0, 1]; 1 = everything (and close the position when the DEX allows it). */
      fraction: z.number().gt(0).max(1),
      output: z.enum(WITHDRAW_OUTPUTS),
    }).strict(),
    claim: z.object(common).strict(),
    compound: z.object(common).strict(),
  } as const;
};

const BODY = {
  "quote-open": z.object({ request: OpenRequestSchema, jupiterRelay: z.unknown().optional() }).strict(),
  open: z.object({ request: OpenRequestSchema, ...StepSchema, jupiterRelay: z.unknown().optional() }).strict(),
  /** Read-only: the wallet's positions in this DEX (the pools it lists), for My positions. Builds nothing. The owner is
   * checked per wallet type by `positionsBody`; this entry only names the op. */
  positions: z.object({ owner: z.string() }).strict(),
  /** Read-only: one position's performance report (its own history and current prices). Builds nothing. */
  performance: z.object({ positionKey: PositionKeySchema }).strict(),
  recovery: z.object({ wallet: solanaOrEvmAddress, positionKey: z.string().min(3).max(160), ...StepSchema, jupiterRelay: z.unknown().optional() }).strict(),
  /** Position ops; the owner is checked per wallet type by `positionOpBody`, these entries only name the ops. */
  add: z.object({ owner: z.string() }).passthrough(),
  withdraw: z.object({ owner: z.string() }).passthrough(),
  claim: z.object({ owner: z.string() }).passthrough(),
  compound: z.object({ owner: z.string() }).passthrough(),
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

/**
 * A `units` range must lie inside the DEX's legal tick / bin id range (`descriptor.meta.rangeUnitBounds`, e.g. Meteora's
 * ±443,636 bin ids) with lower <= upper; otherwise 400 before the adapter reads anything.
 */
function rangeProblem(adapter: DexAdapter, request: OpenRequest): string | null {
  if (request.range.kind !== "units") return null;
  const { lower, upper } = request.range;
  const { min, max } = adapter.descriptor.meta.rangeUnitBounds;
  const unit = adapter.descriptor.meta.rangeUnit;
  if (lower < min || lower > max || upper < min || upper > max) return `The range must use ${unit} ids between ${min} and ${max}.`;
  if (lower > upper) return `The lower ${unit} id must not be above the upper ${unit} id.`;
  return null;
}

function checkedOpen(adapter: DexAdapter, request: OpenRequest): OpenRequest {
  const problem = rangeProblem(adapter, request);
  if (problem) throw new DexError("INVALID_REQUEST", problem);
  return request;
}

async function run(adapter: DexAdapter, op: Op, body: unknown): Promise<Response> {
  switch (op) {
    case "quote-open": {
      const { request } = BODY[op].parse(body);
      return json(await adapter.quoteOpen(checkedOpen(adapter, request as OpenRequest)));
    }
    case "open": {
      const input = BODY[op].parse(body);
      const request = checkedOpen(adapter, input.request as OpenRequest);
      return json(withPermits(await adapter.prepareOpen(request, stepContext(input)), request.owner));
    }
    case "positions": {
      const { owner } = positionsBody(adapter).parse(body);
      return json({ positions: await adapter.listPositions(owner) });
    }
    case "performance": {
      const { positionKey } = BODY[op].parse(body);
      if (!adapter.descriptor.capabilities.performance.supported) throw new DexError("UNSUPPORTED", adapter.descriptor.capabilities.performance.reason);
      return json(await adapter.performance(positionKey as PositionKey));
    }
    case "add": {
      const input = positionOpBody(adapter).add.parse(body);
      return json(withPermits(await adapter.prepareAdd(input.positionKey as PositionKey, input.owner, input.input, stepContext(input)), input.owner));
    }
    case "withdraw": {
      const input = positionOpBody(adapter).withdraw.parse(body);
      if (!adapter.descriptor.capabilities.withdrawOutputs.includes(input.output)) {
        throw new DexError("UNSUPPORTED", "Withdrawing to that token isn't available for this pool yet. Choose one of the outputs the Withdraw panel offers.");
      }
      const request = { fraction: input.fraction, output: input.output };
      return json(withPermits(await adapter.prepareWithdraw(input.positionKey as PositionKey, input.owner, request, stepContext(input)), input.owner));
    }
    case "claim": {
      const input = positionOpBody(adapter).claim.parse(body);
      return json(withPermits(await adapter.prepareClaim(input.positionKey as PositionKey, input.owner, stepContext(input)), input.owner));
    }
    case "compound": {
      const input = positionOpBody(adapter).compound.parse(body);
      return json(withPermits(await adapter.prepareCompound(input.positionKey as PositionKey, input.owner, stepContext(input)), input.owner));
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
  if (dexRouteRateLimited(request, op)) {
    return Response.json({ error: "Too many requests. Please wait a minute.", code: "RATE_LIMITED" }, { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } });
  }
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
