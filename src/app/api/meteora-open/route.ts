import { apiError } from "@/lib/api-response";
import { rpcConnection } from "@sofinance/engine/rpc";
import { DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE, MeteoraOpenBlockedError, prepareMeteoraCloseRefund, prepareMeteoraDeposit, prepareMeteoraSetup } from "@/lib/meteora-open";
import { MeteoraOpenRequestSchema } from "@/lib/meteora-open-request";
import {
  issueMeteoraTxPermit, METEORA_PERMIT_TTL_MS, METEORA_WALLET_FEE_ALLOWANCE_LAMPORTS, meteoraTransactionStatus, MeteoraSendError, sendMeteoraTransaction,
  type MeteoraTxKind, type MeteoraTxSummary,
} from "@/lib/meteora-open-send";
import { readMeteoraWalletBalances } from "@/lib/meteora-open-view";
import { isMeteoraDlmmTxBuildEnabled, isMeteoraDlmmWalletSigningEnabled } from "@/lib/protocol-flags";

/**
 * POST /api/meteora-open — Meteora DLMM open flow.
 * - `setup` (1/2) / `deposit` (2/2) / `close` return an unsigned, simulated transaction, and `balances` reads the wallet,
 *   behind `METEORA_DLMM_TX_BUILD_ENABLED` (off in production → 404).
 * - With `METEORA_DLMM_WALLET_SIGNING_ENABLED` (preview + development; production off → 404) prepared transactions carry a
 *   permit, `send` broadcasts the user's wallet-signed transaction after the server checks, and `status` polls it.
 *   The server never holds a user key.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;
const SIGNATURE_LAMPORTS = 5_000n;
const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { ...NO_STORE, "Content-Type": "application/json" } });

function withPermit<T extends { transaction: string; blockhash: string; lastValidBlockHeight: number; wallet: string; position: string }>(
  kind: MeteoraTxKind, poolId: string, result: T, maxSolDebitLamports: bigint,
) {
  if (!isMeteoraDlmmWalletSigningEnabled()) return result;
  const summary: MeteoraTxSummary = {
    kind, wallet: result.wallet, poolId, position: result.position, blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight,
    expiresAt: Date.now() + METEORA_PERMIT_TTL_MS, maxSolDebitLamports: (maxSolDebitLamports + METEORA_WALLET_FEE_ALLOWANCE_LAMPORTS).toString(),
  };
  return { ...result, summary, permit: issueMeteoraTxPermit(result.transaction, summary) };
}

const SIGNING_ACTIONS = new Set(["send", "status"]);

export async function POST(request: Request) {
  if (!isMeteoraDlmmTxBuildEnabled()) return notFound();
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const parsed = MeteoraOpenRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  const input = parsed.data;
  if (SIGNING_ACTIONS.has(input.action) && !isMeteoraDlmmWalletSigningEnabled()) return notFound();
  const connection = rpcConnection();
  try {
    switch (input.action) {
      case "send": return json(await sendMeteoraTransaction(input, { connection }));
      case "status": return json(await meteoraTransactionStatus(input, connection));
      case "balances": return json(await readMeteoraWalletBalances(input.wallet, connection));
      case "close": {
        const result = await prepareMeteoraCloseRefund(input, { connection });
        return json(withPermit("close", input.poolId, result, SIGNATURE_LAMPORTS));
      }
      case "setup": {
        const result = await prepareMeteoraSetup({ ...input, amount: BigInt(input.amount) }, { connection });
        return json(withPermit("setup", input.poolId, result, BigInt(result.rent.totalLamports)));
      }
      case "deposit": {
        const result = await prepareMeteoraDeposit({ ...input, amount: BigInt(input.amount) }, { connection });
        return json(withPermit("deposit", input.poolId, result, BigInt(DEPOSIT_INTERMEDIATE_RENT_ALLOWANCE) + SIGNATURE_LAMPORTS));
      }
    }
  } catch (error) {
    if (error instanceof MeteoraOpenBlockedError) {
      const extra = error as MeteoraOpenBlockedError & { rent?: unknown; minimum?: unknown };
      return json({ error: error.message, code: error.code, rent: extra.rent, minimum: extra.minimum }, 422);
    }
    if (error instanceof MeteoraSendError) {
      return json({ error: error.message, sent: error.sent, signature: (error as MeteoraSendError & { signature?: string }).signature }, error.sent ? 502 : 422);
    }
    return apiError(error, "Meteora open request failed", 503);
  }
}

export function GET() {
  return notFound();
}
