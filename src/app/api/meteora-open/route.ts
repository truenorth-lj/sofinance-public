import { apiError } from "@/lib/api-response";
import { rpcConnection } from "@sofinance/engine/rpc";
import { MeteoraOpenBlockedError, prepareMeteoraCloseRefund, prepareMeteoraDeposit, prepareMeteoraSetup } from "@/lib/meteora-open";
import { MeteoraRecordError, recordMeteoraOpen } from "@/lib/meteora-open-record";
import { MeteoraOpenRequestSchema } from "@/lib/meteora-open-request";
import { isMeteoraDlmmTxBuildEnabled, isMeteoraDlmmWalletSigningEnabled } from "@/lib/protocol-flags";

/**
 * POST /api/meteora-open — Meteora DLMM open flow. `setup` (1/2) / `deposit` (2/2) / `close` return an unsigned,
 * simulated transaction behind `METEORA_DLMM_TX_BUILD_ENABLED` (off in production → 404). `record` verifies a landed
 * open on chain and logs it, behind `METEORA_DLMM_WALLET_SIGNING_ENABLED` (off everywhere → 404). Never signs or sends.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;
const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { ...NO_STORE, "Content-Type": "application/json" } });

export async function POST(request: Request) {
  if (!isMeteoraDlmmTxBuildEnabled()) return notFound();
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const parsed = MeteoraOpenRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  const input = parsed.data;
  if (input.action === "record" && !isMeteoraDlmmWalletSigningEnabled()) return notFound();
  const connection = rpcConnection();
  try {
    if (input.action === "record") return json(await recordMeteoraOpen(input, connection));
    if (input.action === "close") return json(await prepareMeteoraCloseRefund(input, { connection }));
    const params = { ...input, amount: BigInt(input.amount) };
    return json(input.action === "setup" ? await prepareMeteoraSetup(params, { connection }) : await prepareMeteoraDeposit(params, { connection }));
  } catch (error) {
    if (error instanceof MeteoraOpenBlockedError) {
      const extra = error as MeteoraOpenBlockedError & { rent?: unknown; minimum?: unknown };
      return json({ error: error.message, code: error.code, rent: extra.rent, minimum: extra.minimum }, 422);
    }
    if (error instanceof MeteoraRecordError) return json({ error: error.message }, 422);
    return apiError(error, "Meteora open build failed", 503);
  }
}

export function GET() {
  return notFound();
}
