"use client";

import type { PositionSelection, SelectedPositionState } from "@sofinance/engine/selected-state";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { TxNotSentError, type PreparedTx, type TxAdapter } from "@/lib/tx-pipeline";
import { RELAY_DEADLINE_MS, selectionKey, type Preflight } from "../selected/selected-preview-model";
import { decodePreparedTransaction } from "./shared";

export type AddInput = {
  selection: PositionSelection; amount: string; rawAmount: bigint; floorBps: number; toleranceBps: number;
  relayStore: JupiterRelayStore;
};
type AddPrepareResponse = Preflight & { unsignedTransaction: string; sendPermit?: string; landedPermit?: string; blockhash: string; lastValidBlockHeight: number;
  startingLiquidity: string; startingBalances: SelectedPositionState["balances"] };
export type AddPrepared = PreparedTx & { preflight: AddPrepareResponse };

/**
 * Add liquidity to an existing Raydium CLMM position. Prepare runs the server's full
 * simulation, measured compute units and min-liquidity floor; the wallet then sends.
 */
export const addLiquidityAdapter: TxAdapter<AddInput, AddPrepared> = {
  flow: "add",
  successTitle: "Liquidity added",
  scope: (input) => input.selection.positionMint,
  async prepare(input, { wallet }) {
    const signal = AbortSignal.timeout(RELAY_DEADLINE_MS);
    const response = await postWithJupiterRelay("/api/selected-prepare", { wallet, ...input.selection, amount: input.amount,
      floorBps: input.floorBps, toleranceBps: input.toleranceBps }, { store: input.relayStore, signal });
    const data = await response.json() as AddPrepareResponse & { error?: string; code?: string };
    if (!response.ok) throw Object.assign(new TxNotSentError(data.error || "Preparation failed. Nothing was sent."), { code: data.code });
    if (!data.simulated || data.quote.wallet !== wallet || selectionKey(data.quote) !== selectionKey(input.selection) ||
      data.quote.requested !== input.rawAmount.toString() || data.quote.floorBps !== input.floorBps ||
      data.quote.toleranceBps !== input.toleranceBps) {
      throw new TxNotSentError("The quote changed while preparing. Nothing was sent; please try again.");
    }
    return {
      transaction: decodePreparedTransaction(data.unsignedTransaction, wallet, data.blockhash),
      lastValidBlockHeight: data.lastValidBlockHeight, positionMint: input.selection.positionMint, preflight: data,
      sendPermit: data.sendPermit, landedPermit: data.landedPermit,
    };
  },
};
