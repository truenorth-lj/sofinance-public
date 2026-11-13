import "@/lib/engine-host";
import "server-only";
import { getProtocolAdapter } from "@sofinance/engine/protocols/registry";
import type { OpenPositionSelection } from "@sofinance/engine/open-state";
import type { OpenRangeInput } from "@sofinance/engine/open-range";
import { issueOpenPositionPermit } from "@/lib/open-permit";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { APP_OPEN_PREPARE, MCP_OPEN_PREPARE } from "./surface-policy";
import { txPermitsFor } from "@/lib/tx-send/permit";

export type OpenPrepareCommand = {
  wallet: string;
  selection: OpenPositionSelection;
  amount: string;
  range: OpenRangeInput;
  floorBps: number;
  toleranceBps?: number;
  nftMint: string;
  /** Accepted for backward compatibility with the step-2 resume client; ignored. Does not waive the fee. */
  solSwapSignature?: string;
};

/** Wallets block one transaction that wraps SOL, swaps and opens; SOL deposits are two transactions. */
export const SINGLE_TX_SOL_OPEN_MESSAGE = "SOL deposits open in two steps (1/2 swap SOL to a pool token, 2/2 open). Swap SOL to a pool token first, then open with that token.";

export async function prepareOpen(command: OpenPrepareCommand, readSigningSecret: () => string,
  profile: typeof APP_OPEN_PREPARE | typeof MCP_OPEN_PREPARE) {
  const { wallet, selection, amount, range, floorBps, toleranceBps, nftMint } = command;
  // Covers both the app route and MCP prepare_open_position (and so /sign links).
  assertSolInputAllowed(selection);
  if (selection.inputKind === "native") throw new Error(SINGLE_TX_SOL_OPEN_MESSAGE);
  const build = () => profile === APP_OPEN_PREPARE
    ? withFeeEstimateRetry(() => getProtocolAdapter().buildAndSimulateOpenPosition(
      wallet, selection, amount, range, floorBps, toleranceBps, { enforceResaleFloor: false, nftMint },
    ))
    : getProtocolAdapter().buildAndSimulateOpenPosition(wallet, selection, amount, range, floorBps, toleranceBps, { nftMint });
  const { summary, transaction } = await build();
  const secret = readSigningSecret();
  const permit = issueOpenPositionPermit(secret, {
    wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
  });
  // Fully unsigned: the client (or MCP agent) signs the wallet first, then the NFT mint.
  // Relay permit for /api/tx-send (app surface only; MCP signs on the sign page, which gets it from verify-sign-token).
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    ...(profile === APP_OPEN_PREPARE ? txPermitsFor(wallet, Buffer.from(transaction.serialize()).toString("base64"), summary.lastValidBlockHeight, secret) : {}) };
}
