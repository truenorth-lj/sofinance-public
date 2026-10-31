"use client";

import type { OpenPositionSummary } from "@sofinance/engine/open-types";
import type { OpenRangePreset } from "@sofinance/engine/open-range-presets";
import { createEphemeralMint } from "@/lib/ephemeral-mint";
import { addMintSignature, missingRequiredSignatures } from "@/lib/open-signatures";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { TxNotSentError, type PreparedTx, type TxAdapter } from "@/lib/tx-pipeline";
import { decodePreparedTransaction } from "./shared";

/** Hard cap so prepare cannot spin past a Jupiter 429 wait with no UI error. */
export const OPEN_PREPARE_TIMEOUT_MS = 45_000;

export type OpenInput = {
  poolId: string; inputMint: string; inputKind: "native" | "token"; amount: string; requested: string;
  rangePreset: OpenRangePreset; minPrice: string; maxPrice: string; relayStore: JupiterRelayStore;
  /** Step 2/2 of a SOL deposit: the landed step-1 swap whose delivered tokens this open spends. */
  solSwapSignature?: string;
  /** Last-moment gate (e.g. a pending SOL swap appeared in another tab). Throw to stop before the wallet. */
  beforeWallet?: () => void;
};
export type OpenPrepared = PreparedTx & { summary: OpenPositionSummary };

/**
 * Open a new Meteora/Raydium position. The position NFT mint is a fresh browser keypair
 * that must sign after the wallet (Phantom signs first), so this adapter supplies `cosign`
 * and the pipeline uses sign-then-send for it. Prepare keeps every server safety check:
 * full simulation, on-chain min-out limits, fee rules.
 */
export const openPositionAdapter: TxAdapter<OpenInput, OpenPrepared> = {
  flow: "open",
  successTitle: "Position opened",
  async prepare(input, { wallet }) {
    const mint = createEphemeralMint();
    try {
      const nftMint = mint.publicKey.toBase58();
      const response = await postWithJupiterRelay("/api/open-prepare", {
        wallet, poolId: input.poolId, inputMint: input.inputMint, inputKind: input.inputKind, amount: input.amount,
        rangePreset: input.rangePreset, minPrice: input.minPrice, maxPrice: input.maxPrice, nftMint,
        ...(input.solSwapSignature ? { solSwapSignature: input.solSwapSignature } : {}),
      }, { store: input.relayStore, signal: AbortSignal.timeout(OPEN_PREPARE_TIMEOUT_MS) });
      const data = await response.json() as { unsignedTransaction?: string; summary?: OpenPositionSummary; error?: string; code?: string };
      if (!response.ok) throw Object.assign(new TxNotSentError(data.error || "Preparation failed. Nothing was sent."), { code: data.code });
      const summary = data.summary;
      if (!data.unsignedTransaction || !summary || summary.wallet !== wallet || summary.poolId !== input.poolId ||
        summary.nftMint !== nftMint || summary.quote.requested !== input.requested ||
        summary.quote.inputMint !== input.inputMint || summary.quote.inputKind !== input.inputKind) {
        throw new TxNotSentError("The prepared position does not match your inputs. Nothing was sent; please try again.");
      }
      const transaction = decodePreparedTransaction(data.unsignedTransaction, wallet, summary.blockhash);
      if (transaction.message.staticAccountKeys[1]?.toBase58() !== nftMint) {
        throw new TxNotSentError("The prepared position does not match your inputs. Nothing was sent; please try again.");
      }
      input.beforeWallet?.();
      return {
        transaction, summary, lastValidBlockHeight: summary.lastValidBlockHeight, positionMint: nftMint,
        cosign: (walletSigned) => {
          const signed = addMintSignature(walletSigned, mint);
          if (missingRequiredSignatures(signed).length) throw new TxNotSentError("A required signature is missing, so nothing was sent.");
          return signed;
        },
        dispose: () => mint.dispose(),
      };
    } catch (error) {
      mint.dispose();
      throw error;
    }
  },
};
