import "@/lib/engine-host";
import "server-only";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import { issueSelectedPermit } from "@/lib/selected-permit";
import type { PositionSelection } from "@sofinance/engine/selected-state";
import type { JupiterRetryBudget } from "@sofinance/engine/jupiter/client";
import { APP_SELECTED_PREPARE, MCP_SELECTED_PREPARE } from "./surface-policy";
import { txPermitsFor } from "@/lib/tx-send/permit";

export type SelectedPrepareCommand = {
  wallet: string;
  selection: PositionSelection;
  amount: string;
  floorBps: number;
  toleranceBps?: number;
};
type SelectedPrepareContext = { signal: AbortSignal; budget: JupiterRetryBudget };

export async function prepareSelected(
  command: SelectedPrepareCommand,
  readSigningSecret: () => string,
  ...surface: [profile: typeof APP_SELECTED_PREPARE, context: SelectedPrepareContext]
    | [profile: typeof MCP_SELECTED_PREPARE]
) {
  const { wallet, selection, amount, floorBps, toleranceBps } = command;
  const [profile, context] = surface;
  const { summary, transaction } = profile === APP_SELECTED_PREPARE
    ? await buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps,
      { enforceResaleFloor: false, signal: context.signal, budget: context.budget })
    : await buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps);
  context?.signal.throwIfAborted();
  const secret = readSigningSecret();
  const permit = issueSelectedPermit(secret, {
    message: Buffer.from(transaction.message.serialize()).toString("base64"), wallet, selection,
    requested: summary.quote.requested, floorBps: summary.quote.floorBps,
    expiresAt: summary.expiresAt, lastValidBlockHeight: summary.lastValidBlockHeight,
    startingLiquidity: summary.startingLiquidity, expectedLiquidity: summary.quote.liquidity,
    rangeSide: summary.quote.rangeSide, startingBalances: summary.startingBalances,
  });
  context?.signal.throwIfAborted();
  // Relay permit for /api/tx-send (app surface only; MCP signs on the sign page, which gets it from verify-sign-token).
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    ...(profile === APP_SELECTED_PREPARE ? txPermitsFor(wallet, Buffer.from(transaction.serialize()).toString("base64"), summary.lastValidBlockHeight, secret) : {}) };
}
